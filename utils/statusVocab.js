// ─────────────────────────────────────────────────────────────────────────
// statusVocab.js — the SINGLE SOURCE OF TRUTH for record status vocabulary.
//
// The database stores ONE canonical status per record. Each portal speaks its
// own "language" to its audience, but every label below maps back to the same
// canonical value — so ops, field and client are never looking at a different
// truth, only a different wording of it.
//
// Rule: portals must NEVER invent a status the others don't understand. If a
// new state is needed, add the canonical key here first, then the three labels.
// Frontends can fetch this at GET /api/v1/meta/status-vocab and localise from it.
// ─────────────────────────────────────────────────────────────────────────

const VOCAB = {
  // Inspection lifecycle (inspections.status)
  inspection: {
    scheduled:   { ops: 'Scheduled',   field: 'Scheduled',  client: 'Inspection scheduled' },
    in_progress: { ops: 'In progress', field: 'On site',    client: 'Inspection ongoing' },
    completed:   { ops: 'Completed',   field: 'Completed',  client: 'Inspection complete' },
    cancelled:   { ops: 'Cancelled',   field: 'Cancelled',  client: 'Cancelled' },
  },

  // Field report lifecycle (inspection_reports.status). A field "Submit" writes
  // `under_review`; the client only ever sees a report once it is approved.
  // Labels below match what each portal actually renders today — verified against
  // ops-field-reports.js, the field portal, and client screens.js. Different words,
  // same underlying record.
  report: {
    draft:          { ops: 'Draft',        field: 'Draft',         client: null },
    under_review:   { ops: 'Under review', field: 'Submitted',     client: 'Awaiting approval' },
    approved:       { ops: 'Approved',     field: 'Approved',      client: 'Report ready' },
    sent_to_client: { ops: 'Sent to client', field: 'Sent',       client: 'Report ready' },
    rejected:       { ops: 'Rejected',     field: 'Needs changes', client: 'Awaiting approval' },
  },

  // Alert / incident lifecycle (alerts.status)
  alert: {
    active:       { ops: 'Active',       field: 'Open',         client: 'Active' },
    dispatched:   { ops: 'Dispatched',   field: 'Dispatched',   client: 'Team dispatched' },
    acknowledged: { ops: 'Acknowledged', field: 'Acknowledged', client: 'Acknowledged' },
    resolved:     { ops: 'Resolved',     field: 'Resolved',     client: 'Resolved' },
  },

  // Work order / maintenance ticket lifecycle (tickets.status, work_type set)
  work_order: {
    scheduled:   { ops: 'Scheduled',   field: 'Scheduled',   client: 'Scheduled' },
    in_progress: { ops: 'In progress', field: 'In progress', client: 'In progress' },
    completed:   { ops: 'Completed',   field: 'Completed',   client: 'Completed' },
    cancelled:   { ops: 'Cancelled',   field: 'Cancelled',   client: 'Cancelled' },
  },

  // Invoice payment state (invoices.payment_status)
  invoice: {
    pending: { ops: 'Pending', field: null, client: 'Due' },
    partial: { ops: 'Partial', field: null, client: 'Part-paid' },
    paid:    { ops: 'Paid',    field: null, client: 'Paid' },
    overdue: { ops: 'Overdue', field: null, client: 'Overdue' },
  },
};

// Resolve a canonical status to an audience label. Falls back to a humanised
// version of the raw value so an unknown status is still legible (never blank).
function label(entity, status, audience = 'ops') {
  const s = String(status || '').toLowerCase();
  const row = VOCAB[entity] && VOCAB[entity][s];
  if (row && row[audience] != null) return row[audience];
  return s ? s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '—';
}

module.exports = { VOCAB, label };
