import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { pool } from '../db/init.js';
import dns from 'dns';

const router = express.Router();

// DNS verification function with timeout
const verifyDomainDNS = (domain) => {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, 10000); // 10 second timeout
    
    dns.resolveMx(domain, (err, addresses) => {
      clearTimeout(timeout);
      
      if (err) {
        console.error(`DNS verification failed for ${domain}:`, err.message);
        resolve(false);
      } else {
        try {
          // Check if MX record points to our mail server
          const isVerified = addresses.some(mx => 
            mx.exchange.toLowerCase().includes('mail.boomlify.com') || 
            mx.exchange.toLowerCase().includes('boomlify.com')
          );
          resolve(isVerified);
        } catch (error) {
          console.error(`Error processing MX records for ${domain}:`, error);
          resolve(false);
        }
      }
    });
  });
};

// Get public domains (no auth required)
router.get('/public', async (req, res) => {
  try {
    // Remove authentication requirement for this route
    const [domains] = await pool.query(
      'SELECT * FROM domains ORDER BY created_at DESC'
    );
    res.json(domains);
  } catch (error) {
    console.error('Failed to fetch public domains:', error);
    res.status(500).json({ error: 'Failed to fetch domains' });
  }
});

// Protected routes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const [domains] = await pool.query('SELECT * FROM domains ORDER BY created_at DESC');
    res.json(domains);
  } catch (error) {
    res.status(400).json({ error: 'Failed to fetch domains' });
  }
});

router.post('/add', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { domain } = req.body;
    const id = uuidv4();

    await pool.query(
      'INSERT INTO domains (id, domain) VALUES (?, ?)',
      [id, domain]
    );

    res.json({ id, domain });
  } catch (error) {
    res.status(400).json({ error: 'Failed to add domain' });
  }
});

// Custom domain routes
// Get user's custom domains
router.get('/custom', authenticateToken, async (req, res) => {
  try {
    const [customDomains] = await pool.query(
      'SELECT * FROM custom_domains WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(customDomains);
  } catch (error) {
    console.error('Failed to fetch custom domains:', error);
    res.status(500).json({ error: 'Failed to fetch custom domains' });
  }
});

// Add custom domain
router.post('/custom/add', authenticateToken, async (req, res) => {
  try {
    const { domain } = req.body;
    
    if (!domain || !domain.trim()) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    // Basic domain validation
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/;
    if (!domainRegex.test(domain.trim())) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    const cleanDomain = domain.trim().toLowerCase();
    const id = uuidv4();

    // Check if domain already exists
    const [existing] = await pool.query(
      'SELECT * FROM custom_domains WHERE domain = ?',
      [cleanDomain]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Domain already exists' });
    }

    // Add domain with pending status
    await pool.query(
      'INSERT INTO custom_domains (id, user_id, domain, status, created_at) VALUES (?, ?, ?, ?, NOW())',
      [id, req.user.id, cleanDomain, 'pending']
    );

    res.json({ 
      id, 
      domain: cleanDomain, 
      status: 'pending',
      message: 'Domain added successfully. Please configure your DNS settings.' 
    });
  } catch (error) {
    console.error('Failed to add custom domain:', error);
    res.status(500).json({ error: 'Failed to add custom domain' });
  }
});

// Verify custom domain DNS
router.post('/custom/:id/verify', authenticateToken, async (req, res) => {
  try {
    const domainId = req.params.id;
    
    // Get domain info
    const [domains] = await pool.query(
      'SELECT * FROM custom_domains WHERE id = ? AND user_id = ?',
      [domainId, req.user.id]
    );

    if (domains.length === 0) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const domain = domains[0];

    // Check if MX records point to our mail server
    const isVerified = await verifyDomainDNS(domain.domain);

    if (isVerified) {
      await pool.query(
        'UPDATE custom_domains SET status = ?, verified_at = NOW(), last_check_at = NOW() WHERE id = ?',
        ['verified', domainId]
      );

      res.json({ 
        success: true, 
        message: 'Domain verified successfully!' 
      });
    } else {
      await pool.query(
        'UPDATE custom_domains SET status = ?, last_check_at = NOW() WHERE id = ?',
        ['failed', domainId]
      );

      res.json({ 
        success: false, 
        message: 'Domain verification failed. Please check your DNS settings.' 
      });
    }
  } catch (error) {
    console.error('Failed to verify domain:', error);
    res.status(500).json({ error: 'Failed to verify domain' });
  }
});

// Delete custom domain
router.delete('/custom/:id', authenticateToken, async (req, res) => {
  try {
    const domainId = req.params.id;
    
    const [result] = await pool.query(
      'DELETE FROM custom_domains WHERE id = ? AND user_id = ?',
      [domainId, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    res.json({ success: true, message: 'Domain deleted successfully' });
  } catch (error) {
    console.error('Failed to delete custom domain:', error);
    res.status(500).json({ error: 'Failed to delete custom domain' });
  }
});

export default router;
