import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';
import { authenticateToken, requireAdmin, authenticateMasterPassword } from '../middleware/auth.js';
import { 
  generateGmailAlias, 
  fetchGmailEmails, 
  getUserAliases,
  rotateUserAlias,
  getGmailAccountStats,
  getEmailCacheStats,
  initializeForwardingService,
  addForwardingMapping,
  getForwardingMappings,
  updateForwardingMappingStatus,
  deleteForwardingMapping,
  getAliasOwner
} from '../services/gmailForwardingService.js';

const router = express.Router();

// Initialize Gmail forwarding service when the server starts
initializeForwardingService().catch(error => {
  console.error('Failed to initialize Gmail forwarding service:', error);
});

// ==================== User Routes ====================

// Create a new Gmail alias
router.post('/create', async (req, res) => {
  try {
    // Allow both authenticated and unauthenticated users
    const userId = req.user?.id || `anon_${uuidv4()}`;
    const { strategy, domain } = req.body; // 'dot' or 'plus', 'gmail.com' or 'googlemail.com'
    
    const alias = await generateGmailAlias(
      userId, 
      strategy || 'dot', 
      domain || 'gmail.com'
    );
    
    // Return in the format expected by frontend
    res.json({ alias });
  } catch (error) {
    console.error('Failed to create Gmail alias:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to create Gmail alias',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get all Gmail aliases for the user
router.get('/aliases', async (req, res) => {
  try {
    // Allow both authenticated and unauthenticated users
    const userId = req.user?.id || req.query.userId || `anon_${uuidv4()}`;
    const aliases = await getUserAliases(userId);
    
    res.json({ aliases });
  } catch (error) {
    console.error('Failed to fetch Gmail aliases:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to fetch Gmail aliases',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Fetch emails for a specific alias
router.get('/:alias/emails', async (req, res) => {
  try {
    // Allow both authenticated and unauthenticated users
    const userId = req.user?.id || req.query.userId || `anon_${uuidv4()}`;
    const { alias } = req.params;
    
    const emails = await fetchGmailEmails(userId, alias);
    
    res.json({ emails });
  } catch (error) {
    console.error('Failed to fetch emails:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to fetch emails',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Rotate to a new Gmail alias
router.post('/rotate', async (req, res) => {
  try {
    // Allow both authenticated and unauthenticated users
    const userId = req.user?.id || req.body.userId || `anon_${uuidv4()}`;
    const { strategy, domain } = req.body;
    
    const alias = await rotateUserAlias(
      userId, 
      strategy || 'dot', 
      domain || 'gmail.com'
    );
    
    // Return in the format expected by frontend
    res.json({ alias });
  } catch (error) {
    console.error('Failed to rotate Gmail alias:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to rotate Gmail alias',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ==================== Public Routes ====================

// Public routes for non-authenticated users
router.post('/public/create', async (req, res) => {
  try {
    const { userId, strategy, domain, version } = req.body;
    
    // Check if version matches
    if (version !== '1.0.0') {
      return res.status(400).json({ 
        error: 'Version mismatch',
        requiresReset: true
      });
    }
    
    // Use userId from body, fallback to query param, then generate new one
    const effectiveUserId = userId || req.query.userId || `anon_${uuidv4()}`;
    
    const alias = await generateGmailAlias(
      effectiveUserId, 
      strategy || 'dot', 
      domain || 'gmail.com'
    );
    
    // Return in the format expected by frontend
    res.json({ alias });
  } catch (error) {
    console.error('Failed to create Gmail alias:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to create Gmail alias',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

router.get('/public/aliases/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { version } = req.query;
    
    // Check if version matches
    if (version !== '1.0.0') {
      return res.status(400).json({ 
        error: 'Version mismatch',
        requiresReset: true
      });
    }
    
    const aliases = await getUserAliases(userId);
    res.json({ aliases });
  } catch (error) {
    console.error('Failed to fetch Gmail aliases:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to fetch Gmail aliases',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

router.get('/public/emails/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    let userId = req.query.userId;
    
    // If no userId provided, try to find the alias owner
    if (!userId) {
      userId = getAliasOwner(alias);
      if (!userId) {
        return res.status(404).json({ 
          error: 'Alias not found or expired',
          code: 'ALIAS_NOT_FOUND'
        });
      }
    }
    
    const emails = await fetchGmailEmails(userId, alias);
    
    res.json({ emails });
  } catch (error) {
    console.error('Failed to fetch emails:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to fetch emails',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

router.post('/public/rotate', async (req, res) => {
  try {
    const { userId, strategy, domain } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    const alias = await rotateUserAlias(
      userId, 
      strategy || 'dot', 
      domain || 'gmail.com'
    );
    
    // Return in the format expected by frontend
    res.json({ alias });
  } catch (error) {
    console.error('Failed to rotate Gmail alias:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to rotate Gmail alias',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Add version check endpoint
router.get('/public/version', (req, res) => {
  res.json({
    version: '1.0.0',
    timestamp: Date.now(),
    requiresReset: false
  });
});

// Debug endpoint to check current code version
router.get('/debug/code-version', (req, res) => {
  res.json({
    message: 'Gmail Forwarding Service - Fixed Status Column Issue',
    version: '2.0.0',
    timestamp: Date.now(),
    deployed: new Date().toISOString(),
    fixes: [
      'Removed status filter from gmail_accounts queries',
      'Added flexible column handling for database schema differences'
    ]
  });
});

// Debug endpoint to check database state
router.get('/debug/database-state', async (req, res) => {
  try {
    // Check admin passphrase
    const adminAccess = req.headers['admin-access'];
    if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Check gmail_forwarding_map table
    let forwardingMappings = [];
    try {
      const [mappings] = await pool.query('SELECT * FROM gmail_forwarding_map LIMIT 5');
      forwardingMappings = mappings;
    } catch (error) {
      forwardingMappings = { error: error.message };
    }
    
    // Check gmail_accounts table (if it exists)
    let gmailAccounts = [];
    try {
      const [accounts] = await pool.query('SELECT * FROM gmail_accounts LIMIT 5');
      gmailAccounts = accounts;
    } catch (error) {
      gmailAccounts = { error: error.message };
    }
    
    // Check table structure
    let tableStructure = {};
    try {
      const [structure] = await pool.query('DESCRIBE gmail_forwarding_map');
      tableStructure.gmail_forwarding_map = structure;
    } catch (error) {
      tableStructure.gmail_forwarding_map = { error: error.message };
    }
    
    try {
      const [structure] = await pool.query('DESCRIBE gmail_accounts');
      tableStructure.gmail_accounts = structure;
    } catch (error) {
      tableStructure.gmail_accounts = { error: error.message };
    }
    
    res.json({
      timestamp: new Date().toISOString(),
      forwardingMappings,
      gmailAccounts,
      tableStructure,
      cacheStats: {
        aliasCount: 0,
        mappingCount: Array.isArray(forwardingMappings) ? forwardingMappings.length : 0
      }
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ==================== Admin Routes ====================

// Add a new Gmail forwarding mapping (replaces old account system)
router.post('/admin/accounts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { gmailAccount, tempMailForwarder } = req.body;
    
    if (!gmailAccount || !tempMailForwarder) {
      return res.status(400).json({ error: 'Gmail account and temp mail forwarder are required' });
    }
    
    const result = await addForwardingMapping(gmailAccount, tempMailForwarder);
    
    res.json(result);
  } catch (error) {
    console.error('Failed to add Gmail forwarding mapping:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to add Gmail forwarding mapping',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Admin route with passphrase for adding Gmail forwarding mapping (alternative auth)
router.post('/admin/accounts-alt', async (req, res) => {
  try {
    // Check admin passphrase
    const adminAccess = req.headers['admin-access'];
    if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { gmailAccount, tempMailForwarder } = req.body;
    
    if (!gmailAccount || !tempMailForwarder) {
      return res.status(400).json({ error: 'Gmail account and temp mail forwarder are required' });
    }
    
    const result = await addForwardingMapping(gmailAccount, tempMailForwarder);
    
    res.json(result);
  } catch (error) {
    console.error('Failed to add Gmail forwarding mapping:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to add Gmail forwarding mapping',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Update Gmail forwarding mapping (replaces account password update)
router.patch('/admin/accounts/:mappingId', async (req, res) => {
  try {
    // Check admin passphrase
    const adminAccess = req.headers['admin-access'];
    if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { mappingId } = req.params;
    const { gmailAccount, tempMailForwarder } = req.body;
    
    if (!gmailAccount && !tempMailForwarder) {
      return res.status(400).json({ error: 'Gmail account or temp mail forwarder is required' });
    }
    
    // Check if mapping exists
    const [mappings] = await pool.query(
      'SELECT id FROM gmail_forwarding_map WHERE id = ?',
      [mappingId]
    );
    
    if (mappings.length === 0) {
      return res.status(404).json({ error: 'Gmail forwarding mapping not found' });
    }
    
    // Build update query dynamically
    const updates = [];
    const values = [];
    
    if (gmailAccount) {
      updates.push('gmail_account = ?');
      values.push(gmailAccount);
    }
    
    if (tempMailForwarder) {
      updates.push('temp_mail_forwarder = ?');
      values.push(tempMailForwarder);
    }
    
    values.push(mappingId);
    
    // Update the mapping
    await pool.query(
      `UPDATE gmail_forwarding_map SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    
    res.json({ message: 'Gmail forwarding mapping updated successfully' });
  } catch (error) {
    console.error('Failed to update Gmail forwarding mapping:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to update Gmail forwarding mapping',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Delete a Gmail forwarding mapping
router.delete('/admin/accounts/:mappingId', async (req, res) => {
  try {
    // Check admin passphrase
    const adminAccess = req.headers['admin-access'];
    if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { mappingId } = req.params;
    
    // Use the existing deleteForwardingMapping function
    const result = await deleteForwardingMapping(mappingId);
    
    res.json(result);
  } catch (error) {
    console.error('Failed to delete Gmail forwarding mapping:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to delete Gmail forwarding mapping',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Toggle Gmail forwarding mapping status
router.patch('/admin/accounts/:mappingId/status', async (req, res) => {
  try {
    // Check admin passphrase
    const adminAccess = req.headers['admin-access'];
    if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { mappingId } = req.params;
    const { status } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    
    // Use the existing updateForwardingMappingStatus function
    const result = await updateForwardingMappingStatus(mappingId, status);
    
    res.json(result);
  } catch (error) {
    console.error('Failed to update Gmail forwarding mapping status:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to update Gmail forwarding mapping status',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get Gmail accounts statistics
router.get('/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const accountStats = await getGmailAccountStats();
    const cacheStats = getEmailCacheStats();
    
    res.json({
      accounts: accountStats,
      cache: cacheStats
    });
  } catch (error) {
    console.error('Failed to get Gmail stats:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to get Gmail stats',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Admin route with passphrase for stats (alternative auth)
router.get('/admin/stats-alt', async (req, res) => {
  try {
    // Check admin passphrase
    const adminAccess = req.headers['admin-access'];
    if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const accountStats = await getGmailAccountStats();
    const cacheStats = getEmailCacheStats();
    
    res.json({
      accounts: accountStats,
      cache: cacheStats
    });
  } catch (error) {
    console.error('Failed to get Gmail stats:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to get Gmail stats',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Admin routes for managing Gmail forwarding mappings

// Get all forwarding mappings (admin only)
router.get('/admin/forwarding-mappings', async (req, res) => {
  // Check admin passphrase
  const adminAccess = req.headers['admin-access'];
  if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const mappings = await getForwardingMappings();
    res.json({ mappings });
  } catch (error) {
    console.error('Failed to get forwarding mappings:', error);
    res.status(500).json({ 
      error: 'Failed to get forwarding mappings',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Add new forwarding mapping (admin only)
router.post('/admin/forwarding-mappings', async (req, res) => {
  // Check admin passphrase
  const adminAccess = req.headers['admin-access'];
  if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const { gmailAccount, tempMailForwarder } = req.body;
    
    if (!gmailAccount || !tempMailForwarder) {
      return res.status(400).json({ error: 'Gmail account and temp mail forwarder are required' });
    }
    
    const result = await addForwardingMapping(gmailAccount, tempMailForwarder);
    res.json(result);
  } catch (error) {
    console.error('Failed to add forwarding mapping:', error);
    res.status(500).json({ 
      error: 'Failed to add forwarding mapping',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update forwarding mapping status (admin only)
router.patch('/admin/forwarding-mappings/:id/status', async (req, res) => {
  // Check admin passphrase
  const adminAccess = req.headers['admin-access'];
  if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!status || !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Valid status (active/inactive) is required' });
    }
    
    const result = await updateForwardingMappingStatus(id, status);
    res.json(result);
  } catch (error) {
    console.error('Failed to update forwarding mapping status:', error);
    res.status(500).json({ 
      error: 'Failed to update forwarding mapping status',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Delete forwarding mapping (admin only)
router.delete('/admin/forwarding-mappings/:id', async (req, res) => {
  // Check admin passphrase
  const adminAccess = req.headers['admin-access'];
  if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const { id } = req.params;
    const result = await deleteForwardingMapping(id);
    res.json(result);
  } catch (error) {
    console.error('Failed to delete forwarding mapping:', error);
    res.status(500).json({ 
      error: 'Failed to delete forwarding mapping',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;
