import { pool } from '../db/init.js';

// In-memory cache for custom domain usage
const customDomainUsageCache = {
  // Structure: { [domainId]: { dailyCount: number, totalCount: number, lastReset: Date } }
  domains: new Map(),
  
  // Clean up expired cache entries (older than 25 hours)
  cleanup() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
    
    for (const [domainId, data] of this.domains.entries()) {
      if (data.lastReset < cutoff) {
        this.domains.delete(domainId);
      }
    }
  },
  
  // Reset daily counters if needed
  resetDailyIfNeeded(domainId) {
    const now = new Date();
    const today = now.toDateString();
    const data = this.domains.get(domainId);
    
    if (!data || data.lastReset.toDateString() !== today) {
      // Reset daily counter
      const newData = {
        dailyCount: 0,
        totalCount: data?.totalCount || 0,
        lastReset: now
      };
      this.domains.set(domainId, newData);
      return newData;
    }
    
    return data;
  }
};

// Custom domain rate limits
const CUSTOM_DOMAIN_LIMITS = {
  DAILY_LIMIT: 20,
  TOTAL_LIMIT: 100
};

// Load usage from database for a domain
async function loadDomainUsageFromDB(domainId) {
  try {
    const [results] = await pool.query(
      'SELECT daily_count, total_count, last_reset_date FROM custom_domains WHERE id = ?',
      [domainId]
    );
    
    if (results.length > 0) {
      const { daily_count, total_count, last_reset_date } = results[0];
      const now = new Date();
      const lastReset = last_reset_date ? new Date(last_reset_date) : new Date(0);
      
      // Check if we need to reset daily counter
      const shouldResetDaily = lastReset.toDateString() !== now.toDateString();
      
      const usage = {
        dailyCount: shouldResetDaily ? 0 : (daily_count || 0),
        totalCount: total_count || 0,
        lastReset: shouldResetDaily ? now : lastReset
      };
      
      // Update cache
      customDomainUsageCache.domains.set(domainId, usage);
      
      // Update DB if daily reset happened
      if (shouldResetDaily) {
        await pool.query(
          'UPDATE custom_domains SET daily_count = 0, last_reset_date = NOW() WHERE id = ?',
          [domainId]
        );
      }
      
      return usage;
    }
    
    return null;
  } catch (error) {
    console.error('Error loading domain usage from DB:', error);
    return null;
  }
}

// Update usage in database (async, non-blocking)
async function updateDomainUsageInDB(domainId, usage) {
  try {
    await pool.query(
      'UPDATE custom_domains SET daily_count = ?, total_count = ?, last_reset_date = ? WHERE id = ?',
      [usage.dailyCount, usage.totalCount, usage.lastReset, domainId]
    );
  } catch (error) {
    console.error('Error updating domain usage in DB:', error);
  }
}

// Get domain usage (cache-first, then DB)
async function getDomainUsage(domainId) {
  // Try cache first
  let usage = customDomainUsageCache.domains.get(domainId);
  
  if (!usage) {
    // Load from database
    usage = await loadDomainUsageFromDB(domainId);
    
    if (!usage) {
      // Initialize if not found
      usage = {
        dailyCount: 0,
        totalCount: 0,
        lastReset: new Date()
      };
      customDomainUsageCache.domains.set(domainId, usage);
      
      // Initialize in DB
      await pool.query(
        'UPDATE custom_domains SET daily_count = 0, total_count = 0, last_reset_date = NOW() WHERE id = ?',
        [domainId]
      );
    }
  }
  
  // Reset daily counter if needed
  usage = customDomainUsageCache.resetDailyIfNeeded(domainId);
  
  return usage;
}

// Increment usage counters
async function incrementDomainUsage(domainId) {
  const usage = await getDomainUsage(domainId);
  
  usage.dailyCount++;
  usage.totalCount++;
  
  // Update cache
  customDomainUsageCache.domains.set(domainId, usage);
  
  // Update DB asynchronously (don't await to avoid blocking)
  updateDomainUsageInDB(domainId, usage);
  
  return usage;
}

// Check if domain has reached limits
export async function checkCustomDomainLimits(domainId) {
  const usage = await getDomainUsage(domainId);
  
  const dailyLimitReached = usage.dailyCount >= CUSTOM_DOMAIN_LIMITS.DAILY_LIMIT;
  const totalLimitReached = usage.totalCount >= CUSTOM_DOMAIN_LIMITS.TOTAL_LIMIT;
  
  return {
    canCreate: !dailyLimitReached && !totalLimitReached,
    dailyLimitReached,
    totalLimitReached,
    dailyCount: usage.dailyCount,
    totalCount: usage.totalCount,
    dailyLimit: CUSTOM_DOMAIN_LIMITS.DAILY_LIMIT,
    totalLimit: CUSTOM_DOMAIN_LIMITS.TOTAL_LIMIT,
    resetTime: new Date(usage.lastReset.getTime() + 24 * 60 * 60 * 1000) // Next day
  };
}

// Middleware to check custom domain rate limits
export async function customDomainRateLimitMiddleware(req, res, next) {
  try {
    const { domainId } = req.body;
    
    if (!domainId) {
      return next(); // No domain specified, let other middleware handle
    }
    
    // Check if this is a custom domain
    const [customDomains] = await pool.query(
      'SELECT id, domain FROM custom_domains WHERE id = ? AND status = ?',
      [domainId, 'verified']
    );
    
    if (customDomains.length === 0) {
      return next(); // Not a custom domain, no limits apply
    }
    
    const customDomain = customDomains[0];
    
    // Check limits
    const limitCheck = await checkCustomDomainLimits(domainId);
    
    if (!limitCheck.canCreate) {
      return res.status(429).json({
        error: 'CUSTOM_DOMAIN_LIMIT_EXCEEDED',
        message: 'Custom domain email creation limit reached',
        limits: {
          daily: {
            current: limitCheck.dailyCount,
            limit: limitCheck.dailyLimit,
            reached: limitCheck.dailyLimitReached
          },
          total: {
            current: limitCheck.totalCount,
            limit: limitCheck.totalLimit,
            reached: limitCheck.totalLimitReached
          },
          resetTime: limitCheck.resetTime,
          domain: customDomain.domain
        }
      });
    }
    
    // Store domain info for later use
    req.customDomainInfo = {
      id: domainId,
      domain: customDomain.domain,
      limits: limitCheck
    };
    
    next();
  } catch (error) {
    console.error('Custom domain rate limit check error:', error);
    next(); // Continue on error to avoid breaking the flow
  }
}

// Increment usage after successful email creation
export async function incrementCustomDomainUsage(domainId) {
  return await incrementDomainUsage(domainId);
}

// Clean up cache periodically
setInterval(() => {
  customDomainUsageCache.cleanup();
}, 60 * 60 * 1000); // Every hour

export { CUSTOM_DOMAIN_LIMITS }; 