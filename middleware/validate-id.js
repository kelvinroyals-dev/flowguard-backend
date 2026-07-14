/* Guard integer route params.

   users.id is INTEGER. A request for /clients/abc passes "abc" straight
   into a $1 placeholder for an int column, and Postgres throws 22P02
   ("invalid input syntax for type integer") — a 500, not a 404. It leaks
   a database error to the caller and looks like a server fault when it's
   really a bad request. */
function requireIntParam(name = 'id') {
  return (req, res, next) => {
    const raw = req.params[name];
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || String(n) !== String(raw).trim() || n < 1) {
      return res.status(400).json({ success: false, error: `Invalid ${name}` });
    }
    req.params[name] = n;
    next();
  };
}
module.exports = { requireIntParam };
