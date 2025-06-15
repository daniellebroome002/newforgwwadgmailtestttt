import { pool } from '../db/init.js';

// In-memory cache for custom domain usage (now per user, not per domain)
const customDomainUsageCache = {
  // Structure: { [userId]: { dailyCount: number, totalCount: number, lastReset: Date } }
  users: new Map(),
  
  // Clean up expired cache entries (older than 25 hours)
  cleanup() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
    
    for (const [userId, data] of this.users.entries()) {
      if (data.lastReset < cutoff) {
        this.users.delete(userId);
      }
    }
  },
  
  // Reset daily counters if needed
  resetDailyIfNeeded(userId) {
    const now = new Date();
    const today = now.toDateString();
    const data = this.users.get(userId);
    
    if (!data || data.lastReset.toDateString() !== today) {
      // Reset daily counter
      const newData = {
        dailyCount: 0,
        totalCount: data?.totalCount || 0,
        lastReset: now
      };
      this.users.set(userId, newData);
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

// Load usage from database for a user (sum across all their custom domains)
async function loadUserUsageFromDB(userId) {
  try {
    const [results] = await pool.query(
      'SELECT SUM(daily_count) as total_daily, SUM(total_count) as total_overall, MAX(last_reset_date) as last_reset FROM custom_domains WHERE user_id = ? AND status = ?',
      [userId, 'verified']
    );
    
    if (results.length > 0 && results[0].total_daily !== null) {
      const { total_daily, total_overall, last_reset } = results[0];
      const now = new Date();
      const lastReset = last_reset ? new Date(last_reset) : new Date(0);
      
      // Check if we need to reset daily counter
      const shouldResetDaily = lastReset.toDateString() !== now.toDateString();
      
      const usage = {
        dailyCount: shouldResetDaily ? 0 : (total_daily || 0),
        totalCount: total_overall || 0,
        lastReset: shouldResetDaily ? now : lastReset
      };
      
      // Update cache
      customDomainUsageCache.users.set(userId, usage);
      
      // Update DB if daily reset happened
      if (shouldResetDaily) {
        await pool.query(
          'UPDATE custom_domains SET daily_count = 0, last_reset_date = NOW() WHERE user_id = ? AND status = ?',
          [userId, 'verified']
        );
      }
      
      return usage;
    }
    
    // Return default usage if no domains found
    const defaultUsage = {
      dailyCount: 0,
      totalCount: 0,
      lastReset: new Date()
    };
    customDomainUsageCache.users.set(userId, defaultUsage);
    return defaultUsage;
  } catch (error) {
    console.error('Error loading user usage from DB:', error);
    return {
      dailyCount: 0,
      totalCount: 0,
      lastReset: new Date()
    };
  }
}

// Update usage in database (async, non-blocking) - now updates the specific domain that was used
async function updateUserUsageInDB(userId, domainId, usage) {
  try {
    // Update the specific domain that was used for the email creation
    await pool.query(
      'UPDATE custom_domains SET daily_count = daily_count + 1, total_count = total_count + 1, last_reset_date = ? WHERE id = ?',
      [usage.lastReset, domainId]
    );
  } catch (error) {
    console.error('Error updating user usage in DB:', error);
  }
}

// Get user usage across all custom domains (cache-first, then DB)
async function getUserUsage(userId) {
  // Clean up old cache entries periodically
  if (Math.random() < 0.1) { // 10% chance
    customDomainUsageCache.cleanup();
  }
  
  // Try cache first
  let usage = customDomainUsageCache.resetDailyIfNeeded(userId);
  
  if (!usage) {
    // Load from database
    usage = await loadUserUsageFromDB(userId);
  }
  
  return usage;
}

// Increment usage counters for a user
async function incrementUserUsage(userId, domainId) {
  const usage = await getUserUsage(userId);
  
  usage.dailyCount++;
  usage.totalCount++;
  
  // Update cache
  customDomainUsageCache.users.set(userId, usage);
  
  // Update DB asynchronously (don't await to avoid blocking)
  updateUserUsageInDB(userId, domainId, usage);
  
  return usage;
}

// Check if user has reached limits across all their custom domains
export async function checkCustomDomainLimits(userId) {
  const usage = await getUserUsage(userId);
  
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
    
    // Check if this is a custom domain and get user info
    const [customDomains] = await pool.query(
      'SELECT id, domain, user_id FROM custom_domains WHERE id = ? AND status = ?',
      [domainId, 'verified']
    );
    
    if (customDomains.length === 0) {
      return next(); // Not a custom domain, no limits apply
    }
    
    const customDomain = customDomains[0];
    
    // Check limits for the user (across all their custom domains)
    const limitCheck = await checkCustomDomainLimits(customDomain.user_id);
    
    if (!limitCheck.canCreate) {
      return res.status(429).json({
        error: 'CUSTOM_DOMAIN_LIMIT_EXCEEDED',
        message: 'Custom domain email creation limit reached across all your domains',
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
      userId: customDomain.user_id,
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
  // Get the user ID for this domain
  const [customDomains] = await pool.query(
    'SELECT user_id FROM custom_domains WHERE id = ? AND status = ?',
    [domainId, 'verified']
  );
  
  if (customDomains.length > 0) {
    return await incrementUserUsage(customDomains[0].user_id, domainId);
  }
  
  return null;
}

// Decrement total count when custom domain email is deleted (daily count stays unchanged)
export async function decrementCustomDomainUsage(tempEmailId) {
  try {
    // Get the custom domain info for this temp email
    const [tempEmails] = await pool.query(
      'SELECT custom_domain_id FROM temp_emails WHERE id = ? AND custom_domain_id IS NOT NULL',
      [tempEmailId]
    );
    
    if (tempEmails.length === 0) {
      return null; // Not a custom domain email, no action needed
    }
    
    const customDomainId = tempEmails[0].custom_domain_id;
    
    // Get the user ID for this domain
    const [customDomains] = await pool.query(
      'SELECT user_id FROM custom_domains WHERE id = ? AND status = ?',
      [customDomainId, 'verified']
    );
    
    if (customDomains.length === 0) {
      return null; // Domain not found or not verified
    }
    
    const userId = customDomains[0].user_id;
    
    // Update cache - decrement total count only (keep daily count unchanged)
    const usage = await getUserUsage(userId);
    if (usage.totalCount > 0) {
      usage.totalCount--; // Decrement total count
      // Keep daily count unchanged - users can't get back daily quota by deleting emails
      
      // Update cache
      customDomainUsageCache.users.set(userId, usage);
      
      // Update database - decrement total_count only
      await pool.query(
        'UPDATE custom_domains SET total_count = GREATEST(total_count - 1, 0) WHERE id = ?',
        [customDomainId]
      );
      
      console.log(`Decremented total count for user ${userId}, domain ${customDomainId}. New total: ${usage.totalCount}`);
      return usage;
    }
    
    return usage;
  } catch (error) {
    console.error('Error decrementing custom domain usage:', error);
    return null;
  }
}

// Clean up cache periodically
setInterval(() => {
  customDomainUsageCache.cleanup();
}, 60 * 60 * 1000); // Every hour

export { CUSTOM_DOMAIN_LIMITS }; 