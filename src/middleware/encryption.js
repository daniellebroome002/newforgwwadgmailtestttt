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
      const keyBytes = Buffer.from(this.keyString, 'utf8');
      const dataBytes = Buffer.from(jsonString, 'utf8');
      
      let encrypted = '';
      for (let i = 0; i < dataBytes.length; i++) {
        const encryptedByte = dataBytes[i] ^ keyBytes[i % keyBytes.length];
        encrypted += encryptedByte.toString(16).padStart(2, '0');
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
      const encryptedBytes = [];
      
      for (let i = 0; i < encrypted.length; i += 2) {
        encryptedBytes.push(parseInt(encrypted.substr(i, 2), 16));
      }
      
      let decrypted = '';
      for (let i = 0; i < encryptedBytes.length; i++) {
        decrypted += String.fromCharCode(encryptedBytes[i] ^ keyBytes[i % keyBytes.length]);
      }
      
      return JSON.parse(decrypted);
    } catch (error) {
      console.error('Decryption error:', error);
      return encryptedData;
    }
  }
}

const encryptionService = new EncryptionService();

// Middleware to encrypt responses
export const encryptResponse = (req, res, next) => {
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