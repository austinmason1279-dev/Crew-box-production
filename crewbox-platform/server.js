// ============================================================
// CREWBOX PLATFORM — SERVER ENTRY POINT
// File: server.js
// ============================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import router from './api/routes/index.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    process.env.APP_URL,
    /\.crewbox\.ai$/,            // allow all crewbox subdomains
    /localhost/,
  ],
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 100,
  standardHeaders: true,
});
app.use('/api', limiter);

// Stricter limit for auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use('/api/auth', authLimiter);

// ── BODY PARSING ─────────────────────────────────────────
// NOTE: Stripe webhooks need raw body — handled in the route itself
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    platform: 'CrewBox',
  });
});

// ── ROUTES ───────────────────────────────────────────────
app.use('/api', router);

// ── ERROR HANDLING ───────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 CrewBox API running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
