// ============================================================
// CREWBOX — CONTRACTOR DASHBOARD
// File: frontend/ContractorDashboard.jsx
//
// Full working React dashboard for the contractor (small biz owner)
// Shows: agent statuses, calls, invoices, jobs, revenue, reviews
// ============================================================

import { useState, useEffect, useCallback } from "react";

// ── MOCK DATA (replace with real API calls) ────────────────
const MOCK_DATA = {
  contractor: {
    businessName: "Mike's HVAC & Cooling",
    ownerName: "Mike Rivera",
    tradeType: "hvac",
    city: "Dallas", state: "TX",
    aiPhone: "(214) 555-0199",
    existingPhone: "(214) 555-0182",
    stripeConnected: true,
    onboardingComplete: true,
  },
  agents: [
    { type: "receptionist", name: "The Receptionist", icon: "📞", status: "active", metric: "4 calls today", metricVal: "4" },
    { type: "estimator", name: "The Estimator", icon: "📋", status: "active", metric: "2 quotes sent", metricVal: "2" },
    { type: "collector", name: "The Collector", icon: "💰", status: "active", metric: "$2,100 recovered", metricVal: "$2,100" },
    { type: "marketer", name: "The Marketer", icon: "📱", status: "active", metric: "Next post: Tue", metricVal: "Tue" },
    { type: "rep", name: "The Rep", icon: "⭐", status: "active", metric: "4.8★ avg rating", metricVal: "4.8★" },
  ],
  kpis: {
    revenueMonth: 14800, callsMonth: 47, quotesMonth: 18, invoicesPaid: 11,
    outstanding: 3200, avgRating: 4.8, reviewsMonth: 6,
  },
  recentCalls: [
    { id: 1, name: "Sarah Johnson", phone: "(469) 555-0143", outcome: "booked", summary: "AC not cooling, booked for Thursday 2pm", time: "2 min ago", amount: null },
    { id: 2, name: "Carlos Mendez", phone: "(972) 555-0287", outcome: "callback", summary: "Needs quote for new unit, will call back", time: "1 hr ago", amount: null },
    { id: 3, name: "Linda Park", phone: "(214) 555-0391", outcome: "booked", summary: "Furnace inspection, booked Monday 10am", time: "3 hrs ago", amount: null },
    { id: 4, name: "Tom Williams", phone: "(817) 555-0112", outcome: "transferred", summary: "Emergency — no heat, transferred to Mike", time: "Yesterday", amount: null },
  ],
  openInvoices: [
    { id: 1, number: "INV-2026-0041", customer: "Sarah Johnson", amount: 1840, daysOverdue: 0, status: "sent" },
    { id: 2, number: "INV-2026-0039", customer: "Robert Kim", amount: 3200, daysOverdue: 8, status: "overdue" },
    { id: 3, number: "INV-2026-0037", customer: "Maria Garcia", amount: 780, daysOverdue: 15, status: "overdue" },
  ],
  recentJobs: [
    { id: 1, title: "AC Unit Replacement", customer: "The Hendersons", status: "completed", amount: 4800, date: "Today" },
    { id: 2, title: "HVAC Tune-Up x2", customer: "Apex Properties", status: "in_progress", amount: 320, date: "Today" },
    { id: 3, title: "Ductwork Repair", customer: "Lisa Crawford", status: "scheduled", amount: 1200, date: "Thu" },
    { id: 4, title: "New Install — 3 ton", customer: "The Nguyens", status: "quoted", amount: 6200, date: "Pending" },
  ],
  reviews: [
    { id: 1, name: "James T.", rating: 5, text: "Mike's crew was fantastic — on time, professional, and fixed everything quickly.", platform: "google", responded: true, date: "2 days ago" },
    { id: 2, name: "Patricia W.", rating: 4, text: "Good work overall, just took a bit longer than expected.", platform: "google", responded: true, date: "5 days ago" },
    { id: 3, name: "Derek M.", rating: 2, text: "Came out twice and the issue still isn't fixed.", platform: "google", responded: false, date: "1 week ago", needsAttention: true },
  ],
};

// ── THEME TOKENS ──────────────────────────────────────────
const T = {
  bg: "#0F0F0F", surface: "#1A1A1A", surface2: "#222222", border: "#2A2A2A",
  yellow: "#F5C800", green: "#22C55E", red: "#EF4444", blue: "#60A5FA",
  orange: "#F97316", white: "#FFFFFF", slate: "#8A9BB0", worn: "#F0EDE8",
};

// ── HELPERS ───────────────────────────────────────────────
const fmt$ = (n) => `$${Number(n).toLocaleString()}`;
const outcomeColor = (o) => o === "booked" ? T.green : o === "transferred" ? T.blue : o === "overdue" ? T.red : T.slate;
const statusColor = (s) => s === "completed" ? T.green : s === "in_progress" ? T.yellow : s === "scheduled" ? T.blue : s === "quoted" ? T.slate : T.slate;
const statusLabel = (s) => ({ completed: "Done", in_progress: "Active", scheduled: "Booked", quoted: "Quote Sent", overdue: "OVERDUE", sent: "Sent", active: "LIVE" })[s] || s;

// ── COMPONENTS ────────────────────────────────────────────

function Badge({ label, color, bg }) {
  return (
    <span style={{
      fontFamily: "monospace", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
      padding: "3px 8px", borderRadius: 4,
      color: color || T.yellow,
      background: bg || "rgba(245,200,0,0.1)",
      border: `1px solid ${color || T.yellow}33`,
    }}>{label}</span>
  );
}

function KPICard({ label, value, sub, color, icon }) {
  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
      padding: "18px 20px", flex: 1, minWidth: 140,
    }}>
      <div style={{ fontFamily: "monospace", fontSize: 10, color: T.slate, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>
        {icon} {label}
      </div>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 32, fontWeight: 900, color: color || T.yellow, lineHeight: 1, letterSpacing: -1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: T.slate, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function AgentCard({ agent, onClick }) {
  const isActive = agent.status === "active";
  return (
    <div onClick={() => onClick(agent)}
      style={{
        background: T.surface, border: `1px solid ${isActive ? T.yellow + "33" : T.border}`,
        borderRadius: 10, padding: "18px 16px", cursor: "pointer",
        transition: "border-color 0.2s, transform 0.15s",
        position: "relative", overflow: "hidden",
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.borderColor = T.yellow + "66"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.borderColor = isActive ? T.yellow + "33" : T.border; }}>
      <div style={{ fontSize: 28, marginBottom: 10 }}>{agent.icon}</div>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: 6, color: T.white }}>
        {agent.name}
      </div>
      <div style={{ fontSize: 12, color: T.slate, marginBottom: 12 }}>{agent.metric}</div>
      <Badge label={isActive ? "LIVE" : "PAUSED"} color={isActive ? T.green : T.slate} bg={isActive ? "rgba(34,197,94,0.1)" : "rgba(138,155,176,0.1)"} />
      {isActive && <div style={{ position: "absolute", top: 14, right: 14, width: 7, height: 7, borderRadius: "50%", background: T.green, animation: "pulse 2s infinite" }} />}
    </div>
  );
}

function CallRow({ call }) {
  const color = outcomeColor(call.outcome);
  return (
    <div style={{ display: "flex", gap: 14, padding: "12px 0", borderBottom: `1px solid ${T.border}`, alignItems: "flex-start" }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, marginTop: 5, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{call.name}</span>
          <span style={{ fontFamily: "monospace", fontSize: 10, color: T.slate }}>{call.time}</span>
        </div>
        <div style={{ fontSize: 12, color: T.slate, lineHeight: 1.5 }}>{call.summary}</div>
        <div style={{ marginTop: 5 }}>
          <Badge label={call.outcome.toUpperCase()} color={color} bg={color + "18"} />
        </div>
      </div>
    </div>
  );
}

function InvoiceRow({ invoice, onSendReminder }) {
  const isOverdue = invoice.status === "overdue";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: `1px solid ${T.border}` }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: T.slate, marginBottom: 2 }}>{invoice.number}</div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{invoice.customer}</div>
        {isOverdue && <div style={{ fontSize: 11, color: T.red, marginTop: 2 }}>{invoice.daysOverdue} days overdue</div>}
      </div>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 900, color: isOverdue ? T.red : T.white }}>
        {fmt$(invoice.amount)}
      </div>
      <Badge label={statusLabel(invoice.status)} color={isOverdue ? T.red : T.yellow} bg={isOverdue ? "rgba(239,68,68,0.1)" : "rgba(245,200,0,0.1)"} />
      {isOverdue && (
        <button onClick={() => onSendReminder(invoice)}
          style={{ background: T.yellow, color: T.bg, border: "none", borderRadius: 5, padding: "5px 10px", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
          Send Reminder
        </button>
      )}
    </div>
  );
}

function JobRow({ job }) {
  const color = statusColor(job.status);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: `1px solid ${T.border}` }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{job.title}</div>
        <div style={{ fontSize: 11, color: T.slate }}>{job.customer} · {job.date}</div>
      </div>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 800, color: T.white }}>{fmt$(job.amount)}</div>
      <Badge label={statusLabel(job.status)} color={color} bg={color + "18"} />
    </div>
  );
}

function ReviewCard({ review, onApproveResponse }) {
  const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
  return (
    <div style={{
      background: review.needsAttention ? "rgba(239,68,68,0.06)" : T.surface2,
      border: `1px solid ${review.needsAttention ? T.red + "44" : T.border}`,
      borderRadius: 8, padding: "14px 16px", marginBottom: 10,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{review.name}</span>
          <span style={{ color: T.yellow, marginLeft: 8, fontSize: 14 }}>{stars}</span>
        </div>
        <span style={{ fontFamily: "monospace", fontSize: 10, color: T.slate }}>{review.date}</span>
      </div>
      <div style={{ fontSize: 13, color: T.slate, lineHeight: 1.55, marginBottom: 8 }}>{review.text}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Badge label={review.platform.toUpperCase()} color={T.blue} bg="rgba(96,165,250,0.1)" />
        {review.responded
          ? <Badge label="RESPONDED" color={T.green} bg="rgba(34,197,94,0.1)" />
          : <button onClick={() => onApproveResponse(review)}
              style={{ background: review.needsAttention ? T.red : T.yellow, color: T.bg, border: "none", borderRadius: 4, padding: "4px 10px", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>
              {review.needsAttention ? "⚠ Review & Respond" : "Post Response"}
            </button>
        }
      </div>
    </div>
  );
}

// ── MAIN DASHBOARD ────────────────────────────────────────

export default function ContractorDashboard() {
  const [activeTab, setActiveTab] = useState("overview");
  const [activeAgent, setActiveAgent] = useState(null);
  const [toast, setToast] = useState(null);
  const data = MOCK_DATA;

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "calls", label: `Calls (${data.recentCalls.length})` },
    { id: "jobs", label: "Jobs" },
    { id: "invoices", label: `Invoices` },
    { id: "reviews", label: "Reviews" },
    { id: "agents", label: "AI Crew" },
  ];

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: T.bg, minHeight: "100vh", color: T.white }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Inter:wght@400;500;600&display=swap');
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(1.4)} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
      `}</style>

      {/* TOP BAR */}
      <div style={{ background: "#0A0A0A", borderBottom: `1px solid ${T.border}`, padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 900, letterSpacing: 1 }}>
            <span style={{ color: T.white }}>CREW</span><span style={{ color: T.yellow }}>BOX</span>
          </div>
          <div style={{ width: 1, height: 20, background: T.border }} />
          <div style={{ fontSize: 13, color: T.slate }}>{data.contractor.businessName}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: T.green, animation: "pulse 2s infinite" }} />
            <span style={{ fontFamily: "monospace", fontSize: 11, color: T.green }}>All agents live</span>
          </div>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: T.yellow, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, color: T.bg, fontSize: 16 }}>
            {data.contractor.ownerName[0]}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 20px" }}>

        {/* GREETING */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 900, textTransform: "uppercase", letterSpacing: -0.5 }}>
            Good morning, <span style={{ color: T.yellow }}>{data.contractor.ownerName.split(" ")[0]}</span> — your AI crew is running.
          </div>
          <div style={{ fontSize: 13, color: T.slate, marginTop: 4 }}>
            {data.contractor.city}, {data.contractor.state} · AI answers on {data.contractor.aiPhone} · Forwards from {data.contractor.existingPhone}
          </div>
        </div>

        {/* KPI ROW */}
        <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
          <KPICard label="Revenue This Month" value={fmt$(data.kpis.revenueMonth)} sub="Net collected" color={T.yellow} icon="💰" />
          <KPICard label="Calls Handled" value={data.kpis.callsMonth} sub="By Receptionist" color={T.green} icon="📞" />
          <KPICard label="Outstanding" value={fmt$(data.kpis.outstanding)} sub="Being collected" color={T.red} icon="📋" />
          <KPICard label="Google Rating" value={`${data.kpis.avgRating}★`} sub={`${data.kpis.reviewsMonth} new reviews`} color={T.yellow} icon="⭐" />
        </div>

        {/* AGENT CARDS */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 28 }}>
          {data.agents.map(a => (
            <AgentCard key={a.type} agent={a} onClick={setActiveAgent} />
          ))}
        </div>

        {/* TABS */}
        <div style={{ display: "flex", gap: 2, marginBottom: 20, background: T.surface, borderRadius: 8, padding: 4, width: "fit-content" }}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "7px 16px", borderRadius: 6, border: "none", cursor: "pointer",
                fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 500,
                background: activeTab === tab.id ? "rgba(245,200,0,0.12)" : "transparent",
                color: activeTab === tab.id ? T.yellow : T.slate,
                transition: "all 0.15s",
              }}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* TAB CONTENT */}
        {activeTab === "overview" && (
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: 14 }}>
                Recent Calls
              </div>
              {data.recentCalls.map(c => <CallRow key={c.id} call={c} />)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: 14 }}>
                  Open Invoices
                </div>
                {data.openInvoices.map(i => <InvoiceRow key={i.id} invoice={i} onSendReminder={() => showToast(`Reminder sent for ${i.number}`)} />)}
              </div>
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: 14 }}>
                  Recent Jobs
                </div>
                {data.recentJobs.slice(0, 3).map(j => <JobRow key={j.id} job={j} />)}
              </div>
            </div>
          </div>
        )}

        {activeTab === "calls" && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 900, textTransform: "uppercase", marginBottom: 16 }}>All Calls</div>
            {data.recentCalls.map(c => <CallRow key={c.id} call={c} />)}
          </div>
        )}

        {activeTab === "jobs" && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 900, textTransform: "uppercase", marginBottom: 16 }}>All Jobs</div>
            {data.recentJobs.map(j => <JobRow key={j.id} job={j} />)}
          </div>
        )}

        {activeTab === "invoices" && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 900, textTransform: "uppercase" }}>Invoices</div>
              <button onClick={() => showToast("New invoice created")}
                style={{ background: T.yellow, color: T.bg, border: "none", borderRadius: 6, padding: "8px 16px", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>
                + New Invoice
              </button>
            </div>
            {data.openInvoices.map(i => <InvoiceRow key={i.id} invoice={i} onSendReminder={() => showToast(`Reminder queued for ${i.number}`)} />)}
          </div>
        )}

        {activeTab === "reviews" && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 900, textTransform: "uppercase" }}>Reviews & Reputation</div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <KPICard label="Avg Rating" value={`${data.kpis.avgRating}★`} sub="Google" color={T.yellow} />
              </div>
            </div>
            {data.reviews.map(r => (
              <ReviewCard key={r.id} review={r} onApproveResponse={() => showToast(r.needsAttention ? "Opening review for approval..." : "AI response posted!")} />
            ))}
          </div>
        )}

        {activeTab === "agents" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {data.agents.map(agent => (
              <div key={agent.type} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 24 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>{agent.icon}</div>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 900, textTransform: "uppercase", marginBottom: 4 }}>{agent.name}</div>
                <div style={{ fontFamily: "monospace", fontSize: 10, color: T.yellow, marginBottom: 14, letterSpacing: "0.1em" }}>STATUS: {agent.status.toUpperCase()}</div>
                <div style={{ fontSize: 13, color: T.slate, marginBottom: 16 }}>{agent.metric}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => showToast(`${agent.name} settings updated`)}
                    style={{ flex: 1, background: "rgba(245,200,0,0.1)", border: "1px solid rgba(245,200,0,0.2)", borderRadius: 6, padding: "8px", color: T.yellow, fontSize: 12, cursor: "pointer", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>
                    Configure
                  </button>
                  <button onClick={() => showToast(`${agent.name} paused`)}
                    style={{ flex: 1, background: "rgba(138,155,176,0.1)", border: "1px solid rgba(138,155,176,0.2)", borderRadius: 6, padding: "8px", color: T.slate, fontSize: 12, cursor: "pointer", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>
                    Pause
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* TOAST */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 999,
          background: toast.type === "success" ? T.green : T.red,
          color: T.white, padding: "12px 20px", borderRadius: 8,
          fontWeight: 600, fontSize: 13, boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          animation: "slideIn 0.2s ease",
        }}>
          {toast.msg}
        </div>
      )}

      {/* AGENT DETAIL MODAL */}
      {activeAgent && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setActiveAgent(null)}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: 32, maxWidth: 440, width: "90%", margin: 20 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 40, marginBottom: 14 }}>{activeAgent.icon}</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, textTransform: "uppercase", marginBottom: 6 }}>{activeAgent.name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 11, color: T.yellow, marginBottom: 16 }}>STATUS: LIVE · {activeAgent.metric}</div>
            <div style={{ fontSize: 14, color: T.slate, lineHeight: 1.65, marginBottom: 20 }}>
              {activeAgent.type === "receptionist" && "Answering every inbound call 24/7. Books jobs, qualifies leads, sends confirmations. Currently forwarding from your existing number."}
              {activeAgent.type === "estimator" && "Generates professional quotes from job photos. Sends via SMS and follows up automatically if no response in 24 hours."}
              {activeAgent.type === "collector" && "Tracking all open invoices and sending smart payment reminders. Tone escalates from friendly to firm to final automatically."}
              {activeAgent.type === "marketer" && "Turning your completed job photos into social posts. Next post scheduled for Tuesday at 9am on Google Business and Facebook."}
              {activeAgent.type === "rep" && "Monitoring your Google reviews and writing responses. Sending review requests after completed jobs. 1-tap approval for negative reviews."}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => { showToast("Settings saved"); setActiveAgent(null); }}
                style={{ flex: 1, background: T.yellow, color: T.bg, border: "none", borderRadius: 7, padding: 12, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
                Configure Agent
              </button>
              <button onClick={() => setActiveAgent(null)}
                style={{ flex: 1, background: "transparent", color: T.slate, border: `1px solid ${T.border}`, borderRadius: 7, padding: 12, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
