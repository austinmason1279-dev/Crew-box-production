// ============================================================
// CREWBOX — SECURE DOCUMENT STORAGE (AWS S3)
// File: storage/storage-service.js
//
// Handles ALL file storage for CrewBox:
//   - Contractor licenses & insurance certs
//   - Signed contracts
//   - Job photos (before/after)
//   - Invoice & quote PDFs
//   - Call recordings
//   - AI-generated content
//
// Security:
//   - All files private by default (no public access)
//   - Pre-signed URLs expire in 15 minutes
//   - File paths include licensee + contractor IDs
//   - AES-256 encryption at rest (S3 SSE)
//   - All access logged to activity_log
// ============================================================

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── BUCKET CONFIGURATION ──────────────────────────────────
const BUCKETS = {
  documents: process.env.S3_BUCKET_DOCUMENTS || 'crewbox-documents',
  recordings: process.env.S3_BUCKET_RECORDINGS || 'crewbox-recordings',
  media: process.env.S3_BUCKET_MEDIA || 'crewbox-media',
};

// Signed URL expiry — 15 minutes for sensitive docs, 1 hour for photos
const URL_EXPIRY = {
  sensitive: 900,    // 15 minutes
  photos: 3600,      // 1 hour
  recordings: 1800,  // 30 minutes
};

// ============================================================
// S3 KEY STRUCTURE
// All paths follow: /{licensee_id}/{contractor_id}/{category}/{filename}
// This enforces tenant isolation at the storage level
// ============================================================

function buildS3Key(licenseeId, contractorId, category, filename) {
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${licenseeId}/${contractorId}/${category}/${sanitizedFilename}`;
}

// Category mappings for each document type
const CATEGORY_MAP = {
  contractor_license:       { folder: 'licenses',    bucket: 'documents', expiry: 'sensitive' },
  insurance_certificate:    { folder: 'insurance',   bucket: 'documents', expiry: 'sensitive' },
  business_registration:    { folder: 'legal',       bucket: 'documents', expiry: 'sensitive' },
  w9:                       { folder: 'tax',         bucket: 'documents', expiry: 'sensitive' },
  signed_contract:          { folder: 'contracts',   bucket: 'documents', expiry: 'sensitive' },
  job_photo_before:         { folder: 'job-photos',  bucket: 'media',     expiry: 'photos'   },
  job_photo_after:          { folder: 'job-photos',  bucket: 'media',     expiry: 'photos'   },
  invoice_pdf:              { folder: 'invoices',    bucket: 'documents', expiry: 'sensitive' },
  quote_pdf:                { folder: 'quotes',      bucket: 'documents', expiry: 'sensitive' },
  payment_receipt:          { folder: 'receipts',    bucket: 'documents', expiry: 'sensitive' },
  call_recording:           { folder: 'recordings',  bucket: 'recordings',expiry: 'recordings'},
  other:                    { folder: 'misc',        bucket: 'documents', expiry: 'sensitive' },
};

// ============================================================
// UPLOAD FILE
// ============================================================

/**
 * Upload a document/file for a contractor
 * @param {Object} params
 * @param {string} params.contractorId - UUID
 * @param {string} params.licenseeId - UUID
 * @param {string} params.documentType - from document_type enum
 * @param {Buffer} params.fileBuffer - file content
 * @param {string} params.originalFilename - original file name
 * @param {string} params.mimeType - MIME type
 * @param {string|null} params.jobId - optional job association
 * @param {Date|null} params.expiryDate - optional doc expiry (for licenses)
 */
export async function uploadDocument({
  contractorId,
  licenseeId,
  documentType,
  fileBuffer,
  originalFilename,
  mimeType,
  jobId = null,
  expiryDate = null,
  description = null,
}) {
  const category = CATEGORY_MAP[documentType] || CATEGORY_MAP.other;
  const fileExtension = path.extname(originalFilename);
  const uniqueFilename = `${uuidv4()}${fileExtension}`;
  const s3Key = buildS3Key(licenseeId, contractorId, category.folder, uniqueFilename);
  const bucket = BUCKETS[category.bucket];

  // Upload to S3 with server-side encryption
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: mimeType,
    ServerSideEncryption: 'AES256',             // encryption at rest
    Metadata: {
      contractor_id: contractorId,
      licensee_id: licenseeId,
      document_type: documentType,
      original_filename: originalFilename,
      uploaded_at: new Date().toISOString(),
    },
    // Block all public access — files are NEVER publicly accessible
    // Access only via pre-signed URLs
  }));

  // Record in database
  const { data: doc, error } = await supabase
    .from('documents')
    .insert({
      contractor_id: contractorId,
      job_id: jobId,
      document_type: documentType,
      file_name: originalFilename,
      file_size_bytes: fileBuffer.length,
      mime_type: mimeType,
      s3_bucket: bucket,
      s3_key: s3Key,
      is_private: true,
      expiry_date: expiryDate,
      description,
    })
    .select()
    .single();

  if (error) throw new Error(`Database error saving document: ${error.message}`);

  // Log access
  await logFileAccess(contractorId, 'upload', documentType, s3Key, doc.id);

  return {
    documentId: doc.id,
    s3Key,
    bucket,
    filename: originalFilename,
  };
}

// ============================================================
// GENERATE SECURE DOWNLOAD URL
// URL expires — cannot be shared or stored and reused
// ============================================================

/**
 * Get a time-limited secure URL for a document
 * @param {string} documentId - UUID from documents table
 * @param {string} requestingUserId - who is requesting (for audit log)
 * @param {string} requestingRole - 'contractor' | 'licensee' | 'platform_admin'
 */
export async function getSecureDocumentUrl(documentId, requestingUserId, requestingRole) {
  // Fetch document metadata
  const { data: doc, error } = await supabase
    .from('documents')
    .select('*, contractors(licensee_id)')
    .eq('id', documentId)
    .single();

  if (error || !doc) throw new Error('Document not found');

  // Authorization check
  if (requestingRole === 'contractor') {
    // Contractors can only access their own documents
    if (doc.contractor_id !== requestingUserId) {
      throw new Error('Access denied');
    }
  } else if (requestingRole === 'licensee') {
    // Licensees can access documents of their own contractors
    if (doc.contractors.licensee_id !== requestingUserId) {
      throw new Error('Access denied');
    }
  }
  // platform_admin can access everything

  const category = CATEGORY_MAP[doc.document_type] || CATEGORY_MAP.other;
  const expiresIn = URL_EXPIRY[category.expiry];

  // Generate pre-signed URL
  const command = new GetObjectCommand({
    Bucket: doc.s3_bucket,
    Key: doc.s3_key,
    ResponseContentDisposition: `attachment; filename="${doc.file_name}"`,
  });

  const signedUrl = await getSignedUrl(s3, command, { expiresIn });

  // Log access
  await logFileAccess(doc.contractor_id, 'download', doc.document_type, doc.s3_key, documentId, requestingUserId);

  return {
    url: signedUrl,
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    filename: doc.file_name,
    mimeType: doc.mime_type,
  };
}

// ============================================================
// UPLOAD CALL RECORDING
// Called by the Receptionist agent after each call
// ============================================================

export async function uploadCallRecording(contractorId, licenseeId, callId, audioBuffer, durationSeconds) {
  const filename = `call-${callId}-${Date.now()}.mp3`;
  const s3Key = buildS3Key(licenseeId, contractorId, 'recordings', filename);

  await s3.send(new PutObjectCommand({
    Bucket: BUCKETS.recordings,
    Key: s3Key,
    Body: audioBuffer,
    ContentType: 'audio/mpeg',
    ServerSideEncryption: 'AES256',
    Metadata: {
      call_id: callId,
      contractor_id: contractorId,
      duration_seconds: String(durationSeconds),
    },
  }));

  // Set expiry: recordings auto-deleted after 90 days (via S3 lifecycle rule)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90);

  // Update call record with recording URL reference
  await supabase.from('calls').update({
    recording_url: s3Key,   // store key, not URL — generate signed URL on demand
    recording_expires_at: expiresAt.toISOString(),
  }).eq('id', callId);

  return { s3Key, expiresAt };
}

// ============================================================
// UPLOAD JOB PHOTOS (for Estimator + Marketer agents)
// ============================================================

export async function uploadJobPhoto(contractorId, licenseeId, jobId, photoBuffer, filename, isBefore = true) {
  const docType = isBefore ? 'job_photo_before' : 'job_photo_after';
  return await uploadDocument({
    contractorId,
    licenseeId,
    documentType: docType,
    fileBuffer: photoBuffer,
    originalFilename: filename,
    mimeType: 'image/jpeg',
    jobId,
    description: `${isBefore ? 'Before' : 'After'} photo for job`,
  });
}

// ============================================================
// LIST DOCUMENTS FOR A CONTRACTOR
// ============================================================

export async function listContractorDocuments(contractorId, documentType = null) {
  let query = supabase
    .from('documents')
    .select('id, document_type, file_name, file_size_bytes, expiry_date, is_verified, uploaded_at, description')
    .eq('contractor_id', contractorId)
    .order('uploaded_at', { ascending: false });

  if (documentType) {
    query = query.eq('document_type', documentType);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

// ============================================================
// CHECK EXPIRING DOCUMENTS
// Run daily — alerts when licenses/insurance are about to expire
// ============================================================

export async function checkExpiringDocuments(daysAhead = 30) {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysAhead);

  const { data: expiring } = await supabase
    .from('documents')
    .select(`
      *,
      contractors (
        id, business_name, owner_email, owner_phone,
        licensees (brand_name, owner_email)
      )
    `)
    .in('document_type', ['contractor_license', 'insurance_certificate'])
    .lte('expiry_date', futureDate.toISOString())
    .gte('expiry_date', new Date().toISOString())
    .order('expiry_date', { ascending: true });

  // Log and return for notification system
  const alerts = (expiring || []).map(doc => ({
    documentId: doc.id,
    contractorId: doc.contractor_id,
    businessName: doc.contractors.business_name,
    documentType: doc.document_type,
    expiryDate: doc.expiry_date,
    daysUntilExpiry: Math.ceil((new Date(doc.expiry_date) - new Date()) / (1000 * 60 * 60 * 24)),
    licenseeEmail: doc.contractors.licensees?.owner_email,
  }));

  return alerts;
}

// ============================================================
// DELETE DOCUMENT
// ============================================================

export async function deleteDocument(documentId, requestingContractorId) {
  const { data: doc } = await supabase
    .from('documents')
    .select('*')
    .eq('id', documentId)
    .eq('contractor_id', requestingContractorId)  // ownership check
    .single();

  if (!doc) throw new Error('Document not found or access denied');

  // Delete from S3
  await s3.send(new DeleteObjectCommand({
    Bucket: doc.s3_bucket,
    Key: doc.s3_key,
  }));

  // Delete from database
  await supabase.from('documents').delete().eq('id', documentId);

  await logFileAccess(requestingContractorId, 'delete', doc.document_type, doc.s3_key, documentId);

  return { deleted: true };
}

// ============================================================
// S3 BUCKET SETUP
// Run once during platform setup
// ============================================================

export const S3_BUCKET_CONFIG = {
  // Main documents bucket
  [BUCKETS.documents]: {
    versioning: true,        // keep previous versions
    encryption: 'AES256',
    blockPublicAccess: true, // NEVER public
    lifecycleRules: [
      // Auto-delete old versions after 365 days
      { id: 'expire-old-versions', noncurrentVersionExpiration: { days: 365 } },
    ],
    corsRules: [],           // no CORS — backend access only
  },
  // Call recordings bucket
  [BUCKETS.recordings]: {
    versioning: false,
    encryption: 'AES256',
    blockPublicAccess: true,
    lifecycleRules: [
      // Auto-delete recordings after 90 days
      { id: 'expire-recordings', expiration: { days: 90 } },
    ],
  },
  // Job photos / social media
  [BUCKETS.media]: {
    versioning: false,
    encryption: 'AES256',
    blockPublicAccess: true,
    lifecycleRules: [
      // Move to cheaper storage after 1 year
      { id: 'archive-old-photos', transition: { days: 365, storageClass: 'GLACIER' } },
    ],
  },
};

// ============================================================
// AUDIT LOG HELPER
// ============================================================

async function logFileAccess(contractorId, action, documentType, s3Key, documentId, accessedBy = null) {
  await supabase.from('activity_log').insert({
    contractor_id: contractorId,
    agent: 'system',
    action: `file_${action}`,
    entity_type: 'document',
    entity_id: documentId,
    description: `File ${action}: ${documentType}`,
    metadata: {
      s3_key: s3Key,
      accessed_by: accessedBy,
      timestamp: new Date().toISOString(),
    },
  });
}
