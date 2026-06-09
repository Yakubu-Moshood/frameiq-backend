/**
 * middleware/auth.js
 * Frameiq — JWT authentication middleware
 */

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'frameiq-dev-secret-change-in-production';

/**
 * Sign a JWT for a user.
 */
function signToken(userId) {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: '30d' });
}

/**
 * Express middleware — attaches req.userId or returns 401.
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { signToken, requireAuth };
