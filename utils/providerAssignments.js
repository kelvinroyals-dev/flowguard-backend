// Public property references must never be compared with internal integer IDs.
// Resolve the declared relationship once per pool; support both deployed schemas.
function createProviderAssignments(pool) {
  let key;
  async function propertyKey() {
    if (!key) {
      const { rows } = await pool.query(`SELECT target.attname AS property_key
        FROM pg_constraint c
        JOIN pg_attribute source ON source.attrelid=c.conrelid AND source.attnum=ANY(c.conkey)
        JOIN pg_attribute target ON target.attrelid=c.confrelid AND target.attnum=ANY(c.confkey)
        WHERE c.contype='f'
          AND c.conrelid='service_provider_property_assignments'::regclass
          AND c.confrelid='properties'::regclass
          AND cardinality(c.conkey)=1 AND source.attname='property_id'`);
      if (rows.length !== 1 || !['id', 'property_id'].includes(rows[0].property_key)) {
        throw new Error('Unsupported provider assignment property relationship');
      }
      key = rows[0].property_key;
    }
    return key;
  }
  async function join() {
    return `JOIN properties p ON p.${await propertyKey()}=a.property_id`;
  }
  async function assign(orgId, publicId, staffId, db = pool) {
    const column = await propertyKey();
    const { rows } = await db.query(`INSERT INTO service_provider_property_assignments
      (service_provider_org_id,property_id,assigned_by,active)
      SELECT $1,p.${column},$3,TRUE FROM properties p WHERE p.property_id=$2
      ON CONFLICT (service_provider_org_id,property_id)
      DO UPDATE SET active=TRUE,assigned_by=EXCLUDED.assigned_by,assigned_at=NOW()
      RETURNING *`, [orgId, publicId, staffId || null]);
    if (!rows.length) throw new Error('Property not found');
    // Keep the API contract public-reference based on either database schema.
    return { ...rows[0], property_id: publicId };
  }
  async function unassign(orgId, publicId) {
    const column = await propertyKey();
    return pool.query(`UPDATE service_provider_property_assignments a SET active=FALSE
      FROM properties p WHERE p.${column}=a.property_id
      AND a.service_provider_org_id=$1 AND p.property_id=$2`, [orgId, publicId]);
  }
  return { propertyKey, join, assign, unassign };
}
module.exports = { createProviderAssignments };
