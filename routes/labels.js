// routes/labels.js — ground-truth labelling for model training (Phase 2 ML).
//
// A supervised flood-risk model needs labelled outcomes: "on this date, this
// estate actually flooded." We already capture flood_incident events from the
// alert-confirm and monitoring flows; this route lets ops log/label them
// directly (e.g. historical incidents), and lists the full label set that the
// Python training pipeline (backend/ml) exports as its target variable.
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');

const router = express.Router();
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

const SEVERITIES = ['minor', 'moderate', 'major', 'severe'];

// POST /labels/flood-incident  { property_id, occurred_at?, severity?, description? }
router.post('/flood-incident', async (req, res) => {
  const b = req.body || {};
  const property_id = b.property_id;
  if (!property_id) return res.status(400).json({ success: false, error: 'property_id is required' });
  const severity = SEVERITIES.includes(String(b.severity)) ? String(b.severity) : 'moderate';
  try {
    const prop = (await pool.query('SELECT property_id FROM properties WHERE property_id=$1', [property_id])).rows[0];
    if (!prop) return res.status(404).json({ success: false, error: 'Property not found' });
    const when = b.occurred_at ? new Date(b.occurred_at) : new Date();
    if (isNaN(when.getTime())) return res.status(400).json({ success: false, error: 'Invalid date' });
    if (when.getTime() > Date.now() + 864e5) return res.status(400).json({ success: false, error: 'Date cannot be in the future' });
    const { rows } = await pool.query(
      `INSERT INTO property_events (property_id, event_type, description, metadata, occurred_at, created_by)
       VALUES ($1,'flood_incident',$2,$3,$4,$5) RETURNING id, occurred_at`,
      [property_id, (b.description || 'Flood incident (labelled for model training)').slice(0, 500),
       JSON.stringify({ source: 'manual_label', severity }), when, req.user.id]);
    res.json({ success: true, data: { id: rows[0].id, occurred_at: rows[0].occurred_at, severity } });
  } catch (err) {
    console.error('POST /labels/flood-incident', err);
    res.status(500).json({ success: false, error: 'Failed to log incident' });
  }
});

// GET /labels/flood-incident?days=730 — the label set for review + ML export.
router.get('/flood-incident', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 730, 30), 3650);
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.property_id, COALESCE(p.property_name, e.property_id) AS estate_name,
              e.description, e.metadata, e.occurred_at, e.created_at
         FROM property_events e
         LEFT JOIN properties p ON p.property_id = e.property_id
        WHERE e.event_type='flood_incident'
          AND e.occurred_at >= NOW() - ($1 || ' days')::interval
        ORDER BY e.occurred_at DESC`, [String(days)]);
    res.json({ success: true, data: { count: rows.length, labels: rows } });
  } catch (err) {
    console.error('GET /labels/flood-incident', err);
    res.status(500).json({ success: false, error: 'Failed to load labels' });
  }
});

module.exports = router;
