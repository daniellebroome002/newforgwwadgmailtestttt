import crypto from 'crypto';

class EncryptionService {
  constructor() {
    this.key = null;
    this.initKey();
  }

  initKey() {
    const keyString = process.env.ENCRYPTION_KEY;
    if (!keyString) {
      console.warn('ENCRYPTION_KEY not found in environment variables');
      return;
    }
    
    // Use the key string directly
    this.keyString = keyString;
  }

  encrypt(data) {
    if (!this.keyString) {
      return data; // Return original if no key available
    }

    try {
      const jsonString = JSON.stringify(data);
      // Convert to Base64 first (UTF-8 safe)
      const base64String = Buffer.from(jsonString, 'utf8').toString('base64');
      const keyBytes = Buffer.from(this.keyString, 'utf8');
      
      let encrypted = '';
      for (let i = 0; i < base64String.length; i++) {
        const charCode = base64String.charCodeAt(i);
        const keyCode = keyBytes[i % keyBytes.length];
        const encryptedChar = charCode ^ keyCode;
        encrypted += encryptedChar.toString(16).padStart(2, '0');
      }
      
      return { encrypted };
    } catch (error) {
      console.error('Encryption error:', error);
      return data; // Return original on error
    }
  }

  decrypt(encryptedData) {
    if (!this.keyString || !encryptedData.encrypted) {
      return encryptedData;
    }

    try {
      const encrypted = encryptedData.encrypted;
      const keyBytes = Buffer.from(this.keyString, 'utf8');
      
      // Convert hex back to characters
      let base64String = '';
      for (let i = 0; i < encrypted.length; i += 2) {
        const encryptedChar = parseInt(encrypted.substr(i, 2), 16);
        const keyCode = keyBytes[(i / 2) % keyBytes.length];
        const originalChar = encryptedChar ^ keyCode;
        base64String += String.fromCharCode(originalChar);
      }
      
      // Decode from Base64 back to UTF-8
      const jsonString = Buffer.from(base64String, 'base64').toString('utf8');
      return JSON.parse(jsonString);
    } catch (error) {
      console.error('Decryption error:', error);
      return encryptedData;
    }
  }
}

const encryptionService = new EncryptionService();

// Middleware to encrypt responses
export const encryptResponse = (req, res, next) => {
  // Skip encryption for OPTIONS requests (CORS preflight)
  if (req.method === 'OPTIONS') {
    return next();
  }
  
  const originalJson = res.json;
  
  res.json = function(data) {
    // Skip encryption for certain routes or conditions
    if (req.path.includes('/admin/') || req.path.includes('/health')) {
      return originalJson.call(this, data);
    }
    
    const encryptedData = encryptionService.encrypt(data);
    return originalJson.call(this, encryptedData);
  };
  
  next();
};

export default encryptionService; 
