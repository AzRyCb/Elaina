import fetch from 'node-fetch';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

function validateDomain(domain) {
    const domainRegex = /^(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/;
    return domainRegex.test(domain);
}

class RateLimiter {
    constructor(maxRequests = 5, timeWindow = 60000) {
        this.requests = new Map();
        this.maxRequests = maxRequests;
        this.timeWindow = timeWindow;
    }
    
    isAllowed(userId) {
        const now = Date.now();
        if (!this.requests.has(userId)) {
            this.requests.set(userId, [now]);
            return true;
        }
        
        const userRequests = this.requests.get(userId);
        const recentRequests = userRequests.filter(time => now - time < this.timeWindow);
        
        if (recentRequests.length < this.maxRequests) {
            recentRequests.push(now);
            this.requests.set(userId, recentRequests);
            return true;
        }
        
        return false;
    }
    
    getTimeUntilNextAllowed(userId) {
        const now = Date.now();
        const userRequests = this.requests.get(userId);
        if (!userRequests || userRequests.length === 0) return 0;
        
        const oldestRequest = Math.min(...userRequests);
        return Math.max(0, this.timeWindow - (now - oldestRequest));
    }
}

async function getSubdomains(domain) {
    const sources = [
        { url: `https://crt.sh/?q=%25.${domain}&output=json`, parser: crtShParser },
        { url: `https://otx.alienvault.com/api/v1/indicators/domain/${domain}/passive_dns`, parser: alienvaultParser },
    ];

    const subdomains = new Set();
    
    await Promise.allSettled(sources.map(async (source) => {
        try {
            const response = await fetch(source.url, { 
                timeout: 15000,
                headers: { 'User-Agent': 'Xnuvers007/1.0' }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            source.parser(data, domain, subdomains);
        } catch (err) {
            console.error(`Error fetching from source:`, err.message);
        }
    }));

    const domainPattern = new RegExp(`(?:^|\\.)${domain.replace(/\./g, '\\.')}$`);

    return Array.from(subdomains).filter(sub => domainPattern.test(sub));
}

function crtShParser(data, domain, subdomains) {
    data.forEach(entry => {
        if (entry.name_value) {
            entry.name_value.split('\n').forEach(sub => {
                const cleanSub = sub.trim().toLowerCase();
                if (cleanSub.endsWith(domain)) {
                    subdomains.add(cleanSub);
                }
            });
        }
    });
}

function alienvaultParser(data, domain, subdomains) {
    if (data.passive_dns) {
        data.passive_dns.forEach(record => {
            if (record.hostname && record.hostname.endsWith(domain)) {
                subdomains.add(record.hostname.toLowerCase());
            }
        });
    }
}

function getDomainHash(domain) {
    return createHash('md5').update(domain).digest('hex');
}

const CACHE_DIR = './tmp/subdomain_cache';
if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR);
}

const rateLimiter = new RateLimiter(10, 180000);

let handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) {
        return m.reply(`⚠️ Masukkan domain yang ingin dicek!\n\n📝 *Contoh*: ${usedPrefix + command} example.com\n\n💡 *Tips*: Gunakan domain tanpa "http://" atau "https://"`);  
    }
    
    text = text.trim().toLowerCase();
    if (text.startsWith('http://') || text.startsWith('https://')) {
        text = text.replace(/^https?:\/\//, '');
        text = text.split('/')[0];
    }
    
    if (!validateDomain(text)) {
        return m.reply(`❌ Format domain tidak valid!`);
    }
    
    const userId = m.sender;
    if (!rateLimiter.isAllowed(userId)) {
        const waitTime = Math.ceil(rateLimiter.getTimeUntilNextAllowed(userId) / 1000);
        return m.reply(`⏳ Mohon tunggu ${waitTime} detik sebelum melakukan pencarian lagi.`);
    }

    const startMsg = await m.reply(`🔍 *Mencari subdomain untuk:* \`${text}\`\n\n⚙️ Memeriksa multiple sources...`);

    try {
        const domainHash = getDomainHash(text);
        const cacheFile = join(CACHE_DIR, `${domainHash}.json`);
        let subdomains = [];
        let cachedResult = false;

        if (existsSync(cacheFile)) {
            unlinkSync(cacheFile);
            try {
                const cacheData = require(cacheFile);
                const cacheTime = new Date(cacheData.timestamp);
                const now = new Date();
                if ((now.getTime() - cacheTime.getTime()) < 24 * 60 * 60 * 1000) {
                    subdomains = cacheData.subdomains;
                    cachedResult = true;
                }
            } catch (e) {
                console.error('Error reading cache file:', e);
            }
        }

        if (!cachedResult) {
            subdomains = await getSubdomains(text);
            writeFileSync(cacheFile, JSON.stringify({
                domain: text,
                subdomains: subdomains,
                timestamp: new Date().toISOString()
            }));
        }

        if (subdomains.length === 0) {
            return conn.reply(m.chat, `📢 *Hasil Pencarian*\n\n❌ Tidak ditemukan subdomain untuk \`${text}\``, m);
        }

        const date = new Date();
        const formattedDate = date.toISOString().split('T')[0].replace(/-/g, '');
        const fileName = `subdomain_${text.replace(/\./g, "_")}_${formattedDate}.txt`;

        subdomains.sort();
        const fileContent = subdomains.join('\n');
        writeFileSync(fileName, fileContent);

        const previewLimit = 15;
        const displayedSubdomains = subdomains.slice(0, previewLimit);
        const formatted = displayedSubdomains.map((sub, i) => `${i + 1}. ${sub}`).join('\n');

        let resultMessage = `🌐 *Hasil Pencarian Subdomain*\n\n`;
        resultMessage += `📋 Ditemukan *${subdomains.length}* subdomain untuk \`${text}\`\n`;
        resultMessage += cachedResult ? `ℹ️ *Data dari cache (< 24 jam)*\n\n` : `\n`;

        if (subdomains.length > previewLimit) {
            resultMessage += `📋 *Menampilkan ${previewLimit} dari ${subdomains.length} subdomain:*\n\n${formatted}\n\n`;
            resultMessage += `💾 *File lengkap telah dikirim secara terpisah.*`;
        } else {
            resultMessage += `📋 *Daftar lengkap:*\n\n${formatted}`;
        }

        await conn.sendFile(m.chat, fileName, fileName, `🌐 Daftar lengkap ${subdomains.length} subdomain untuk ${text}\n📅 ${date.toLocaleDateString()}`, m, true);
        unlinkSync(fileName);
        await conn.sendMessage(m.chat, { text: resultMessage }, { quoted: startMsg });

    } catch (err) {
        console.error('Subdomain check error:', err);
        await conn.reply(m.chat, `❌ *Terjadi kesalahan saat memeriksa subdomain*\n\nDetail error: ${err.message}`, m);
    }
};

handler.help = ['subdomainchecker', 'subdir', 'subsdir', 'subfinder', 'subcheck', 'subcek'].map(v => v + ' <domain>');
handler.tags = ['internet', 'tools'];
handler.command = /^(subdomainchecker|subdir|subsdir|subfinder|subcheck|subcek)$/i;
handler.limit = true;
handler.cooldown = 60;

export default handler;
