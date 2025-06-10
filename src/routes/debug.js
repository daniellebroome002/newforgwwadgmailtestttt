import express from 'express';
import { authenticateMasterPassword } from '../middleware/auth.js';
import { 
  getGmailAccountStats,
  getEmailCacheStats,
  getForwardingMappings
} from '../services/gmailForwardingService.js';

const router = express.Router();

// Apply admin authentication to all routes
router.use(authenticateMasterPassword);
router.use((req, res, next) => {
  if (!req.isAdminAuth) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
});

// Get Gmail forwarding service debug report
router.get('/gmail', async (req, res) => {
  try {
    const accountStats = await getGmailAccountStats();
    const cacheStats = getEmailCacheStats();
    const mappings = await getForwardingMappings();
    
    const report = {
      timestamp: new Date().toISOString(),
      service: 'Gmail Forwarding (No IMAP)',
      accounts: accountStats,
      cache: cacheStats,
      forwardingMappings: {
        count: mappings.length,
        active: mappings.filter(m => m.status === 'active').length,
        mappings: mappings
      }
    };
    
    res.json({ report });
  } catch (error) {
    console.error('Failed to generate Gmail debug report:', error);
    res.status(500).json({ error: 'Failed to generate debug report' });
  }
});

// Dump Gmail forwarding service status to console
router.post('/gmail/dump', async (req, res) => {
  try {
    const accountStats = await getGmailAccountStats();
    const cacheStats = getEmailCacheStats();
    const mappings = await getForwardingMappings();
    
    console.log('======= GMAIL FORWARDING SERVICE DEBUG =======');
    console.log(`Generated at: ${new Date().toISOString()}`);
    console.log(`Service Type: Gmail Forwarding (No IMAP)`);
    console.log('\n--- ACCOUNTS ---');
    console.log(`Total Gmail accounts: ${accountStats.length}`);
    console.table(accountStats);
    
    console.log('\n--- FORWARDING MAPPINGS ---');
    console.log(`Total mappings: ${mappings.length}`);
    console.log(`Active mappings: ${mappings.filter(m => m.status === 'active').length}`);
    console.table(mappings.map(m => ({
      gmail: m.gmail_account,
      forwarder: m.temp_mail_forwarder,
      status: m.status,
      created: new Date(m.created_at).toLocaleDateString()
    })));
    
    console.log('\n--- CACHE STATS ---');
    console.log(`Total aliases: ${cacheStats.totalAliases}`);
    console.log(`Cached emails: ${cacheStats.totalCachedEmails}`);
    console.log(`Connected clients: ${cacheStats.connectedClients}`);
    console.log(`Active connections: ${cacheStats.activeConnections}`);
    console.log('===============================================');
    
    res.json({ message: 'Gmail forwarding service status dumped to console' });
  } catch (error) {
    console.error('Failed to dump Gmail service status:', error);
    res.status(500).json({ error: 'Failed to dump status' });
  }
});

// Get forwarding mapping for specific Gmail account
router.get('/gmail/account/:email/mapping', async (req, res) => {
  try {
    const { email } = req.params;
    const mappings = await getForwardingMappings();
    const mapping = mappings.find(m => m.gmail_account === email);
    
    if (!mapping) {
      return res.status(404).json({ 
        error: 'No forwarding mapping found for this Gmail account',
        email 
      });
    }
    
    res.json({ mapping });
  } catch (error) {
    console.error('Failed to get forwarding mapping:', error);
    res.status(500).json({ error: 'Failed to get forwarding mapping' });
  }
});

export default router;