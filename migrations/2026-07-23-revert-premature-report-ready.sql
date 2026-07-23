-- Inspection completion used to flip a property to 'report_ready' before the
-- report was approved. Revert any property still stuck there that has NO
-- approved/sent report, so the client correctly shows "Awaiting approval"
-- again. Properties with a genuinely approved report are left untouched.
UPDATE properties p
   SET status = 'inspection_ongoing', updated_at = NOW()
 WHERE p.status = 'report_ready'
   AND NOT EXISTS (
     SELECT 1 FROM inspection_reports r
      WHERE r.property_id = p.property_id
        AND r.status IN ('approved', 'sent_to_client')
   );
