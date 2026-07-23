// routes/meta.js — cross-portal metadata. Exposes the canonical status
// vocabulary so ops, field and client all localise from ONE source of truth.
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { VOCAB } = require('../utils/statusVocab');

// GET /api/v1/meta/status-vocab — canonical statuses + per-audience labels.
// Any authenticated portal can read this to keep wording consistent.
router.get('/status-vocab', authenticateToken, (req, res) => {
  res.json({ success: true, data: VOCAB });
});

module.exports = router;
