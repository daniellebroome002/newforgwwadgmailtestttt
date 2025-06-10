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
      // Use Buffer methods throughout to preserve UTF-8
      const jsonString = JSON.stringify(data);
      const jsonBuffer = Buffer.from(jsonString, 'utf8');
      const base64String = jsonBuffer.toString('base64');
      const keyBuffer = Buffer.from(this.keyString, 'utf8');
      
      // XOR the base64 string (which is ASCII safe)
      let encrypted = '';
      for (let i = 0; i < base64String.length; i++) {
        const charCode = base64String.charCodeAt(i);
        const keyCode = keyBuffer[i % keyBuffer.length];
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
      const keyBuffer = Buffer.from(this.keyString, 'utf8');
      
      // Convert hex back to base64 string
      let base64String = '';
      for (let i = 0; i < encrypted.length; i += 2) {
        const encryptedChar = parseInt(encrypted.substr(i, 2), 16);
        const keyCode = keyBuffer[(i / 2) % keyBuffer.length];
        const originalChar = encryptedChar ^ keyCode;
        base64String += String.fromCharCode(originalChar);
      }
      
      // Decode from Base64 back to UTF-8 using Buffer
      const jsonBuffer = Buffer.from(base64String, 'base64');
      const jsonString = jsonBuffer.toString('utf8');
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
