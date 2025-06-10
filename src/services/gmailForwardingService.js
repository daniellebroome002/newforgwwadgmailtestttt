import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';

// In-memory storage for aliases and user management
const aliasCache = new Map(); // Cache for active aliases during runtime
const connectedClients = new Map(); // Map of userId:alias -> Set of websocket connections
const aliasToAccountMap = new Map(); // Quick lookup of alias to account
const emailCache = new Map(); // Cache for received emails (for WebSocket delivery)
const forwardingMap = new Map(); // Cache for Gmail → TempMail forwarding mappings

// Configuration
const ALIAS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds for in-memory cache

// Encryption utilities for password security
const encryptionKey = process.env.ENCRYPTION_KEY || 'default-encryption-key';

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptionKey), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts[0], 'hex');
  const encryptedText = Buffer.from(textParts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(encryptionKey), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// Utility function to notify all connected clients for an alias when new email arrives
function notifyClients(alias, email) {
  if (!isAliasActive(alias)) {
    return;
  }
  
  const notification = {
    type: 'new_email',
    email,
    alias,
    timestamp: new Date().toISOString()
  };
  
  const payload = JSON.stringify(notification);
  let notifiedCount = 0;
  
  // Find all clients connected to this alias
  const clients = [];
  for (const [clientKey, clientSet] of connectedClients.entries()) {
    if (clientKey.includes(`:${alias}`)) {
      clientSet.forEach(client => clients.push(client));
    }
  }
  
  // Send notification to all connected clients
  if (clients.length > 0) {
    Promise.all(
      clients
        .filter(client => client.readyState === 1) // Only OPEN connections
        .map(client => {
          return new Promise(resolve => {
            try {
              client.send(payload, { 
                binary: false, 
                compress: true
              }, () => resolve());
              notifiedCount++;
            } catch (err) {
              resolve();
            }
          });
        })
    ).catch(() => {});
  }
  
  console.log(`Notified ${notifiedCount} clients about new email for alias ${alias}`);
}

// Setup WebSocket Server for real-time notifications
export function setupWebSocketServer(server) {
  const wss = new WebSocketServer({ 
    server,
    perMessageDeflate: {
      zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
      zlibInflateOptions: { chunkSize: 10 * 1024 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      clientMaxWindowBits: 10,
      serverMaxWindowBits: 10,
      concurrencyLimit: 10,
      threshold: 1024
    }
  });
  
  console.log('WebSocket server created for Gmail forwarding real-time updates');
  
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    const alias = url.searchParams.get('alias');
    
    if (!userId || !alias) {
      ws.close();
      return;
    }
    
    const clientKey = `${userId}:${alias}`;
    console.log(`WebSocket client connected: ${clientKey}`);
    
    // Add to connected clients
    if (!connectedClients.has(clientKey)) {
      connectedClients.set(clientKey, new Set());
    }
    connectedClients.get(clientKey).add(ws);
    
    // Send initial connection message
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to Gmail forwarding service',
      timestamp: new Date().toISOString(),
      alias
    }));
    
    // Handle client disconnection
    ws.on('close', () => {
      console.log(`WebSocket client disconnected: ${clientKey}`);
      if (connectedClients.has(clientKey)) {
        connectedClients.get(clientKey).delete(ws);
        if (connectedClients.get(clientKey).size === 0) {
          connectedClients.delete(clientKey);
        }
      }
    });
    
    // Handle ping/pong for connection health
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error) {
        // Ignore invalid messages
      }
    });
  });
  
  return wss;
}

// Gmail Forwarding Management (replaces direct account management)
export async function addGmailForwardingMapping(gmailAccount, tempMailForwarder) {
  // This function is replaced by addForwardingMapping below
  // Keeping for backward compatibility but redirecting to new implementation
  return await addForwardingMapping(gmailAccount, tempMailForwarder);
}

// Generate Gmail alias using dot notation or plus addressing
export async function generateGmailAlias(userId, strategy = 'dot', domain = 'gmail.com') {
  try {
    console.log(`Generating Gmail alias for user ${userId} with strategy ${strategy}`);
    
    // Get active forwarding mappings instead of gmail_accounts
    const [mappings] = await pool.query(
      'SELECT * FROM gmail_forwarding_map WHERE status = "active" ORDER BY RAND() LIMIT 1'
    );
    
    if (mappings.length === 0) {
      throw new Error('No active Gmail forwarding mappings available. Please configure Gmail forwarding first.');
    }
    
    const mapping = mappings[0];
    const gmailAccount = mapping.gmail_account;
    
    let alias;
    let attempts = 0;
    const maxAttempts = 10;
    
    // Generate unique alias based on the Gmail account from mapping
    do {
      if (strategy === 'plus') {
        alias = generatePlusAlias(gmailAccount, domain);
      } else {
        alias = generateDotAlias(gmailAccount, domain);
      }
      attempts++;
    } while (aliasCache.has(alias) && attempts < maxAttempts);
    
    if (attempts >= maxAttempts) {
      throw new Error('Unable to generate unique alias after multiple attempts');
    }
    
    // Store alias in cache
    const aliasData = {
      alias,
      userId,
      parentAccountId: mapping.id,
      parentAccountEmail: gmailAccount,
      tempMailForwarder: mapping.temp_mail_forwarder,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      strategy,
      domain
    };
    
    aliasCache.set(alias, aliasData);
    aliasToAccountMap.set(alias, gmailAccount);
    
    console.log(`Generated Gmail alias: ${alias} for user ${userId} via forwarding mapping ${mapping.id}`);
    return alias;
  } catch (error) {
    console.error('Error generating Gmail alias:', error);
    throw error;
  }
}

// Alias generation functions
function generateDotAlias(email, domain = 'gmail.com') {
  const username = email.split('@')[0];
  
  // Insert dots randomly in username
  let dotUsername = '';
  for (let i = 0; i < username.length - 1; i++) {
    dotUsername += username[i];
    // Random chance to insert a dot, but ensure no consecutive dots
    if (Math.random() > 0.5 && username[i] !== '.' && username[i+1] !== '.') {
      dotUsername += '.';
    }
  }
  // Add last character
  dotUsername += username[username.length - 1];
  
  return `${dotUsername}@${domain}`;
}

function generatePlusAlias(email, domain = 'gmail.com') {
  const username = email.split('@')[0];
  
  // Add random tag
  const tag = Math.random().toString(36).substring(2, 8);
  
  return `${username}+${tag}@${domain}`;
}

// Get emails for a specific alias (returns cached emails)
export async function fetchGmailEmails(userId, aliasEmail) {
  try {
    console.log(`Fetching emails for alias: ${aliasEmail}, user: ${userId}`);
    
    // Check if alias exists in cache
    if (!aliasCache.has(aliasEmail)) {
      throw new Error('Alias not found or expired');
    }
    
    const aliasData = aliasCache.get(aliasEmail);
    
    // Check if this user owns this alias
    if (aliasData.userId !== userId) {
      throw new Error('Unauthorized access to alias');
    }
    
    // Update last used timestamp
    aliasData.lastUsed = Date.now();
    aliasCache.set(aliasEmail, aliasData);
    
    // Get cached emails for this alias
    const cachedEmails = [];
    for (const [key, email] of emailCache.entries()) {
      if (key.startsWith(`${aliasEmail}:`)) {
        cachedEmails.push(email);
      }
    }
    
    // Sort by timestamp (newest first)
    cachedEmails.sort((a, b) => b.timestamp - a.timestamp);
    
    console.log(`Found ${cachedEmails.length} cached emails for alias ${aliasEmail}`);
    return cachedEmails;
  } catch (error) {
    console.error('Error fetching Gmail emails:', error);
    throw error;
  }
}

// Get user's aliases
export async function getUserAliases(userId) {
  try {
    const userAliases = [];
    
    for (const [alias, data] of aliasCache.entries()) {
      if (data.userId === userId) {
        userAliases.push({
          alias,
          createdAt: new Date(data.createdAt).toISOString(),
          parentAccount: data.parentAccountEmail,
          strategy: data.strategy,
          domain: data.domain
        });
      }
    }
    
    return userAliases;
  } catch (error) {
    console.error('Error getting user aliases:', error);
    throw error;
  }
}

// Rotate user alias (generate new one)
export async function rotateUserAlias(userId, strategy = 'dot', domain = 'gmail.com') {
  try {
    console.log(`Rotating alias for user ${userId}`);
    
    // Remove old aliases for this user
    for (const [alias, data] of aliasCache.entries()) {
      if (data.userId === userId) {
        aliasCache.delete(alias);
        aliasToAccountMap.delete(alias);
      }
    }
    
    // Generate new alias
    const newAlias = await generateGmailAlias(userId, strategy, domain);
    return newAlias;
  } catch (error) {
    console.error('Error rotating user alias:', error);
    throw error;
  }
}

// Store received email in cache (called by webhook)
export function storeReceivedEmail(aliasEmail, emailData) {
  try {
    if (!aliasCache.has(aliasEmail)) {
      console.log(`Alias ${aliasEmail} not found in cache, skipping email storage`);
      return false;
    }
    
    const cacheKey = `${aliasEmail}:${emailData.id}`;
    
    // Add timestamp if not present
    if (!emailData.timestamp) {
      emailData.timestamp = Date.now();
    }
    
    // Store in email cache
    emailCache.set(cacheKey, emailData);
    
    // Notify connected WebSocket clients
    notifyClients(aliasEmail, emailData);
    
    // Update alias last used time
    const aliasData = aliasCache.get(aliasEmail);
    aliasData.lastUsed = Date.now();
    aliasCache.set(aliasEmail, aliasData);
    
    console.log(`Stored email ${emailData.id} for alias ${aliasEmail}`);
    return true;
  } catch (error) {
    console.error('Error storing received email:', error);
    return false;
  }
}

// Cleanup inactive aliases
export async function cleanupInactiveAliases() {
  try {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [alias, data] of aliasCache.entries()) {
      if (now - data.lastUsed > ALIAS_TTL) {
        aliasCache.delete(alias);
        aliasToAccountMap.delete(alias);
        
        // Remove associated emails from cache
        for (const [key] of emailCache.entries()) {
          if (key.startsWith(`${alias}:`)) {
            emailCache.delete(key);
          }
        }
        
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} inactive aliases`);
    }
  } catch (error) {
    console.error('Error cleaning up inactive aliases:', error);
  }
}

// Get Gmail forwarding statistics
export async function getGmailAccountStats() {
  try {
    // Get all forwarding mappings instead of gmail_accounts
    const [mappings] = await pool.query(
      'SELECT * FROM gmail_forwarding_map ORDER BY gmail_account'
    );
    
    // Count active aliases per Gmail account
    const aliasStats = new Map();
    for (const [alias, data] of aliasCache.entries()) {
      const parentEmail = data.parentAccountEmail;
      aliasStats.set(parentEmail, (aliasStats.get(parentEmail) || 0) + 1);
    }
    
    return {
      totalAccounts: mappings.length,
      totalAliases: aliasCache.size,
      totalUsers: new Set([...aliasCache.values()].map(a => a.userId)).size,
      accounts: mappings.map(mapping => ({
        id: mapping.id,
        email: mapping.gmail_account,
        tempMailForwarder: mapping.temp_mail_forwarder,
        aliasCount: aliasStats.get(mapping.gmail_account) || 0,
        quotaUsed: 0, // Not applicable in forwarding mode
        status: mapping.status || 'unknown',
        lastUsed: mapping.created_at
      }))
    };
  } catch (error) {
    console.error('Error getting Gmail forwarding stats:', error);
    throw error;
  }
}

// Get email cache statistics
export function getEmailCacheStats() {
  return {
    totalAliases: aliasCache.size,
    totalCachedEmails: emailCache.size,
    connectedClients: connectedClients.size,
    activeConnections: Array.from(connectedClients.values()).reduce((sum, clientSet) => sum + clientSet.size, 0)
  };
}

// Check if alias is active
function isAliasActive(alias) {
  if (!aliasCache.has(alias)) {
    return false;
  }
  
  const aliasData = aliasCache.get(alias);
  const now = Date.now();
  
  return (now - aliasData.lastUsed) <= ALIAS_TTL;
}

// Load Gmail forwarding mappings from database
async function loadForwardingMappings() {
  try {
    // First try to get all mappings to see what columns exist
    const [mappings] = await pool.query(
      'SELECT * FROM gmail_forwarding_map'
    );
    
    console.log(`Loading ${mappings.length} Gmail forwarding mappings...`);
    
    // Filter active mappings based on available columns
    const activeMappings = mappings.filter(mapping => {
      // Check if mapping has status column and is active, or if no status column just include all
      return !mapping.hasOwnProperty('status') || mapping.status === 'active' || mapping.status === 1;
    });
    
    for (const mapping of activeMappings) {
      forwardingMap.set(mapping.temp_mail_forwarder, mapping.gmail_account);
    }
    
    console.log(`Loaded ${forwardingMap.size} active forwarding mappings`);
  } catch (error) {
    console.error('Error loading forwarding mappings:', error);
    throw error;
  }
}

// Add Gmail forwarding mapping
export async function addForwardingMapping(gmailAccount, tempMailForwarder) {
  try {
    const id = uuidv4();
    
    // Try to insert without status column first (in case the column doesn't exist)
    try {
      await pool.query(
        'INSERT INTO gmail_forwarding_map (id, gmail_account, temp_mail_forwarder) VALUES (?, ?, ?)',
        [id, gmailAccount, tempMailForwarder]
      );
    } catch (insertError) {
      // If that fails, try with status column
      if (insertError.code === 'ER_BAD_FIELD_ERROR') {
        console.log('Trying insert with status column...');
        await pool.query(
          'INSERT INTO gmail_forwarding_map (id, gmail_account, temp_mail_forwarder, status) VALUES (?, ?, ?, "active")',
          [id, gmailAccount, tempMailForwarder]
        );
      } else {
        throw insertError;
      }
    }
    
    // Update in-memory cache
    forwardingMap.set(tempMailForwarder, gmailAccount);
    
    console.log(`Added forwarding mapping: ${gmailAccount} → ${tempMailForwarder}`);
    return { success: true, id };
  } catch (error) {
    console.error('Error adding forwarding mapping:', error);
    throw error;
  }
}

// Get all forwarding mappings
export async function getForwardingMappings() {
  try {
    const [mappings] = await pool.query(
      'SELECT * FROM gmail_forwarding_map ORDER BY created_at DESC'
    );
    return mappings;
  } catch (error) {
    console.error('Error getting forwarding mappings:', error);
    throw error;
  }
}

// Update forwarding mapping status
export async function updateForwardingMappingStatus(id, status) {
  try {
    // Check if status column exists first
    try {
      const [result] = await pool.query(
        'UPDATE gmail_forwarding_map SET status = ? WHERE id = ?',
        [status, id]
      );
      
      if (result.affectedRows > 0) {
        // Reload mappings to update cache
        await loadForwardingMappings();
        return { success: true };
      }
      
      return { success: false, message: 'Mapping not found' };
    } catch (updateError) {
      if (updateError.code === 'ER_BAD_FIELD_ERROR') {
        console.log('Status column does not exist, status update skipped');
        return { success: true, message: 'Status column not available' };
      } else {
        throw updateError;
      }
    }
  } catch (error) {
    console.error('Error updating forwarding mapping status:', error);
    throw error;
  }
}

// Delete forwarding mapping
export async function deleteForwardingMapping(id) {
  try {
    // Get the mapping first to update cache
    const [mappings] = await pool.query(
      'SELECT * FROM gmail_forwarding_map WHERE id = ?',
      [id]
    );
    
    if (mappings.length === 0) {
      return { success: false, message: 'Mapping not found' };
    }
    
    const mapping = mappings[0];
    
    // Delete from database
    await pool.query('DELETE FROM gmail_forwarding_map WHERE id = ?', [id]);
    
    // Remove from cache
    forwardingMap.delete(mapping.temp_mail_forwarder);
    
    console.log(`Deleted forwarding mapping: ${mapping.gmail_account} → ${mapping.temp_mail_forwarder}`);
    return { success: true };
  } catch (error) {
    console.error('Error deleting forwarding mapping:', error);
    throw error;
  }
}

// Check if email is a forwarded Gmail email and get original recipient
export function parseForwardedEmail(recipientEmail, emailData) {
  try {
    // Check if recipient matches any temp mail forwarder
    if (!forwardingMap.has(recipientEmail)) {
      return null;
    }
    
    const gmailAccount = forwardingMap.get(recipientEmail);
    console.log(`Email forwarded from Gmail account: ${gmailAccount} via ${recipientEmail}`);
    
    // Try to extract original recipient from email headers or body
    let originalRecipient = null;
    
    // Method 1: Check email headers for original recipient
    if (emailData.headers && emailData.headers['x-original-to']) {
      originalRecipient = emailData.headers['x-original-to'];
    }
    
    // Method 2: Check for forwarded email markers in subject or body
    if (!originalRecipient && emailData.subject) {
      // Look for forwarded email patterns
      if (emailData.subject.includes('Fwd:') || emailData.bodyText) {
        // Try to extract from email body - look for "To:" lines
        const toMatch = emailData.bodyText?.match(/To:\s*([^\r\n]+)/i);
        if (toMatch) {
          originalRecipient = toMatch[1].trim();
        }
      }
    }
    
    // Method 3: Check email envelope/routing headers
    if (!originalRecipient && emailData.headers) {
      const deliveredTo = emailData.headers['delivered-to'] || 
                          emailData.headers['envelope-to'] ||
                          emailData.headers['x-envelope-to'];
      if (deliveredTo && deliveredTo !== recipientEmail) {
        originalRecipient = deliveredTo;
      }
    }
    
    return {
      gmailAccount,
      originalRecipient,
      forwarder: recipientEmail
    };
  } catch (error) {
    console.error('Error parsing forwarded email:', error);
    return null;
  }
}

// Initialize the forwarding service
export async function initializeForwardingService() {
  try {
    console.log('Initializing Gmail forwarding service...');
    
    // Load forwarding mappings from database
    await loadForwardingMappings();
    
    // Start cleanup interval for inactive aliases
    setInterval(cleanupInactiveAliases, 60 * 60 * 1000); // Every hour
    
    // Refresh forwarding mappings every 5 minutes
    setInterval(loadForwardingMappings, 5 * 60 * 1000);
    
    console.log('Gmail forwarding service initialized successfully');
    return true;
  } catch (error) {
    console.error('Failed to initialize Gmail forwarding service:', error);
    throw error;
  }
} 