/**
 * Core Google Maps Scraping Engine
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/124.0.2478.80'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanPhoneNumber(rawPhone) {
  if (!rawPhone) return '';
  while (Array.isArray(rawPhone) && rawPhone.length > 0) {
    rawPhone = rawPhone[0];
  }
  if (typeof rawPhone !== 'string') return '';
  
  // Format sering kali membawa data tracking dipisahkan koma
  const firstSegment = rawPhone.split(',')[0].trim();
  
  // Ekstrak pola nomor telepon Indonesia jika masih kotor
  const match = firstSegment.match(/(\+62|08|\(02\d\)|\b02\d\b)[\d\s\-]{6,16}/);
  if (match) {
    return match[0].trim();
  }
  return firstSegment;
}

/**
 * Melakukan query search Google Maps per halaman (20 hasil per batch)
 */
export async function fetchGoogleMapsPage(query, offset = 0, retries = 2) {
  const cleanQuery = String(query || '').slice(0, 120);
  const safeOffset = Math.max(0, Math.min(200, parseInt(offset, 10) || 0));
  const encQuery = encodeURIComponent(cleanQuery).replace(/%20/g, '+');
  const pb = `!1s${encQuery}!7i20!8i${safeOffset}!10b1`;
  const url = `https://www.google.com/search?tbm=map&authuser=0&hl=id&gl=id&q=${encQuery}&pb=${encodeURIComponent(pb)}`;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': '*/*',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://www.google.com/maps',
          'Cache-Control': 'no-cache'
        }
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      let text = await res.text();
      clearTimeout(timeout);
      if (text.startsWith(")]}'\n")) {
        text = text.slice(5);
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('Respons Google tidak valid (kemungkinan diblokir/CAPTCHA)');
      }
      if (!Array.isArray(data) || !Array.isArray(data[0]?.[1])) {
        throw new Error('Struktur respons Google berubah / kosong');
      }
      const rawListings = data[0]?.[1] || [];
      const results = [];

      for (const item of rawListings) {
        if (!item || !item[14]) continue;
        const p = item[14];

        const name = (p[11] || '').trim();
        if (!name) continue;

        // Kategori / jenis usaha spesifik
        let category = 'Kost';
        if (Array.isArray(p[13]) && p[13].length > 0 && p[13][0]) {
          category = p[13][0].trim();
        }

        // Alamat lengkap
        let address = (p[39] || '').trim();
        if (!address && Array.isArray(p[2])) {
          address = p[2].filter(Boolean).map(s => String(s).trim()).join(', ');
        }

        // Nomor telepon (p[178] adalah field utama kontak)
        let phone = cleanPhoneNumber(p[178]);
        if (!phone) {
          // Fallback deep scan jika tersimpan di indeks lain
          for (const idx of [181, 208, 227]) {
            const val = p[idx];
            if (typeof val === 'string' && val.match(/^(\+62|08|\(02\d\)|\b02\d\b)[\d\s\-]{6,16}$/)) {
              phone = cleanPhoneNumber(val);
              if (phone) break;
            }
          }
        }

        // Website resmi (p[7])
        let website = '';
        if (Array.isArray(p[7]) && p[7][0]) {
          website = String(p[7][0]).trim();
        } else if (typeof p[7] === 'string' && p[7].startsWith('http')) {
          website = p[7].trim();
        }

        // Rating & ulasan (p[4])
        let rating = null;
        let reviewsCount = 0;
        if (Array.isArray(p[4])) {
          if (typeof p[4][7] === 'number') rating = Number(p[4][7].toFixed(1));
          if (typeof p[4][8] === 'number') reviewsCount = Math.floor(p[4][8]);
        }

        // Place ID & Google Maps link
        const placeId = p[78] || '';
        const mapsUrl = placeId ? `https://www.google.com/maps/place/?q=place_id:${placeId}` : '';

        // Koordinat latitude & longitude
        let lat = null;
        let lng = null;
        if (Array.isArray(p[9])) {
          lat = typeof p[9][2] === 'number' ? p[9][2] : null;
          lng = typeof p[9][3] === 'number' ? p[9][3] : null;
        }

        results.push({
          placeId,
          name,
          category,
          address,
          phone,
          website,
          rating,
          reviewsCount,
          mapsUrl,
          lat,
          lng
        });
      }

      return results;
    } catch (err) {
      clearTimeout(timeout);
      // Jangan mutasi err (AbortError/DOMException: message getter-only)
      const isAbort = err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''));
      const reason = isAbort ? 'Timeout 20s' : (err?.message || String(err));
      if (attempt <= retries) {
        await sleep(1000 * attempt + Math.floor(Math.random() * 500));
        continue;
      }
      console.warn(`[Warning] Gagal fetch "${query}" offset ${offset}: ${reason}`);
      return [];
    }
  }
  return [];
}
