/**
 * routes/auth.js
 * Frameiq — Auth routes (async sqlite3 version)
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const { v4: uuid } = require('uuid');

const { queries }                = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'email and password required' });

  try {
    const existing = await queries.getUserByEmail(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash   = bcrypt.hashSync(password, 10);
    const userId = uuid();
    await queries.createUser(userId, email.toLowerCase().trim(), hash);
    return res.status(201).json({ token: signToken(userId), userId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'email and password required' });

  try {
    const user = await queries.getUserByEmail(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (!bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Invalid credentials' });

    return res.json({ token: signToken(user.id), userId: user.id, email: user.email });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await queries.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ userId: user.id, email: user.email });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
