/**
 * Server-side AI Auto-Reply Module
 * Supports: Gemini (FREE), Claude, OpenAI
 * Priority: Gemini > Claude > OpenAI (Gemini is free!)
 */

let aiConfig = {
  enabled: false,
  geminiKey: '',     // FREE - Google AI Studio key (AIza...)
  claudeKey: '',
  openaiKey: '',
  systemPrompt: '',
  botDelay: 3,
  msgMode: 'partes',
  useEmojis: true,
  contactMap: {},
};

const replyingTo = new Set();
const chatHistory = new Map();
const MAX_HISTORY = 10;

// ── USAGE TRACKING ──────────────────────────────────────────
const usageData = {
  // { 'YYYY-MM-DD': count }
  daily: {},
};

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function recordUsage() {
  const key = getTodayKey();
  usageData.daily[key] = (usageData.daily[key] || 0) + 1;

  // Clean up entries older than 30 days
  const keys = Object.keys(usageData.daily).sort();
  if (keys.length > 30) {
    for (let i = 0; i < keys.length - 30; i++) {
      delete usageData.daily[keys[i]];
    }
  }
}

function getUsageStats() {
  const todayKey = getTodayKey();
  const today = usageData.daily[todayKey] || 0;

  // Last 7 days
  const lastSevenDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    lastSevenDays.push(usageData.daily[key] || 0);
  }

  // Day labels (short)
  const dayLabels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dayLabels.push(['Dom','Lun','Mar','Mie','Jue','Vie','Sab'][d.getDay()]);
  }

  // Determine limit based on provider
  const useGemini = aiConfig.geminiKey && aiConfig.geminiKey.startsWith('AIza');
  const limit = useGemini ? 250 : 999999; // Gemini free = ~250/day

  return {
    today,
    limit,
    lastSevenDays,
    dayLabels,
    provider: useGemini ? 'gemini' : aiConfig.claudeKey ? 'claude' : aiConfig.openaiKey ? 'openai' : 'none',
    totalThisWeek: lastSevenDays.reduce((a, b) => a + b, 0),
  };
}