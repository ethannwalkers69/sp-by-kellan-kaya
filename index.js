const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const total = new Map();

// ============================================================
// KONFIGURASYON PARA SA PAGE PUBLISHING
// ============================================================
// Palitan ang dalawang ito ng totoong Page ID at Page Access Token.
// Ang Page Access Token ay nakuha mula sa Graph API Explorer
// (pumili ng Page, pagkatapos ay kunin ang token na may
//  pages_manage_posts at pages_read_engagement permissions).
const PAGE_ID = process.env.FB_PAGE_ID || 'ILAGAY_DITO_ANG_PAGE_ID';
const PAGE_ACCESS_TOKEN =
  process.env.FB_PAGE_ACCESS_TOKEN || 'ILAGAY_DITO_ANG_PAGE_ACCESS_TOKEN';

// ============================================================
// ROUTES
// ============================================================

app.get('/total', (req, res) => {
  const data = Array.from(total.values()).map((link, index) => ({
    session: link.session,
    url: link.url,
    count: link.count,
    id: link.id,
    target: link.target,
  }));
  res.json(data);
});

app.get('/', (res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/submit', async (req, res) => {
  const { cookie, url, amount, interval } = req.body;

  if (!cookie || !url || !amount || !interval) {
    return res.status(400).json({
      error: 'Missing state, url, amount, or interval',
    });
  }

  try {
    const cookies = await convertCookie(cookie);
    if (!cookies) {
      return res.status(400).json({
        status: 500,
        error: 'Invalid cookies',
      });
    }

    // Ang share() ay hindi na naghihintay ng buong proseso;
    // agad itong nagbabalik pagkatapos ma-validate ang input.
    await share(cookies, url, Number(amount), Number(interval));

    res.status(200).json({ status: 200 });
  } catch (err) {
    return res.status(500).json({
      status: 500,
      error: err.message || String(err),
    });
  }
});

// ============================================================
// SHARE LOGIC (PAGE-BASED PUBLISHING)
// ============================================================

async function share(cookies, url, amount, interval) {
  const id = await getPostID(url);
  if (!id) {
    throw new Error(
      'Unable to get link id: invalid URL, private post, or unsupported share link'
    );
  }

  // I-validate na may Page token bago magsimula
  if (
    !PAGE_ID ||
    PAGE_ID === 'ILAGAY_DITO_ANG_PAGE_ID' ||
    !PAGE_ACCESS_TOKEN ||
    PAGE_ACCESS_TOKEN === 'ILAGAY_DITO_ANG_PAGE_ACCESS_TOKEN'
  ) {
    throw new Error(
      'Page publishing is not configured. Set FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN.'
    );
  }

  // I-check kung may tumatakbo nang proseso para sa parehong post ID
  for (const entry of total.values()) {
    if (entry.id === id && entry.running) {
      throw new Error(`A share process for post ID ${id} is already running.`);
    }
  }

  const session = crypto.randomUUID();
  total.set(session, {
    session,
    url,
    id,
    count: 0,
    target: amount,
    running: true,
  });

  const headers = {
    accept: '*/*',
    cookie: cookies,
    host: 'graph.facebook.com',
  };

  let sharedCount = 0;
  let timer;

  async function sharePost() {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/${PAGE_ID}/feed`,
        {
          link: `https://m.facebook.com/${id}`,
          published: false,
          access_token: PAGE_ACCESS_TOKEN,
        },
        { headers }
      );

      if (response.status === 200) {
        const current = total.get(session);
        if (current) {
          current.count += 1;
          total.set(session, current);
        }
        sharedCount++;

        if (sharedCount >= amount) {
          clearInterval(timer);
          const done = total.get(session);
          if (done) {
            done.running = false;
            total.set(session, done);
          }
        }
      }
    } catch (error) {
      console.error(
        'sharePost error:',
        error.response?.data || error.message
      );
      clearInterval(timer);
      total.delete(session);
    }
  }

  // Unang share agad, pagkatapos ay interval
  sharePost();
  timer = setInterval(sharePost, interval * 1000);

  // Safety timeout para hindi tumakbo nang walang hanggan
  setTimeout(() => {
    clearInterval(timer);
    const entry = total.get(session);
    if (entry && entry.running) {
      entry.running = false;
      total.set(session, entry);
    }
  }, amount * interval * 1000 + 5000);
}

// ============================================================
// POST ID PARSING
// ============================================================

async function getPostID(url) {
  try {
    // Early return kung may fbid= o story_fbid= na sa URL
    const directFbid = url.match(/[?&]fbid=(\d+)/);
    if (directFbid) {
      console.log('Direct fbid found:', directFbid[1]);
      return directFbid[1];
    }

    const directStory = url.match(/[?&]story_fbid=(\d+)/);
    if (directStory) {
      console.log('Direct story_fbid found:', directStory[1]);
      return directStory[1];
    }

    // Kung share link, sundan ang redirect
    const resolved = await axios.get(url, {
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const finalUrl =
      resolved.request?.res?.responseUrl || resolved.config?.url || url;

    console.log('Resolved URL:', finalUrl);

    const patterns = [
      /\/posts\/(\d+)/,
      /[?&]story_fbid=(\d+)/,
      /[?&]fbid=(\d+)/,
      /\/reel\/(\d+)/,
      /\/videos\/(\d+)/,
      /\/permalink\/(\d+)/,
      /\/share\/p\/([A-Za-z0-9]+)/,
    ];

    for (const pattern of patterns) {
      const match = finalUrl.match(pattern);
      if (match) return match[1];
    }

    // Fallback sa third-party service
    const response = await axios.post(
      'https://id.traodoisub.com/api.php',
      `link=${encodeURIComponent(url)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    if (response.data && response.data.id) return response.data.id;

    return null;
  } catch (error) {
    console.error('getPostID error:', error.message);
    return null;
  }
}

// ============================================================
// ACCESS TOKEN (para sa user token, hindi na kailangan sa Page
// publishing, pero pinapanatili para sa compatibility)
// ============================================================

async function getAccessToken(cookie) {
  try {
    const headers = {
      authority: 'business.facebook.com',
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'accept-language':
        'vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5',
      'cache-control': 'max-age=0',
      cookie: cookie,
      referer: 'https://www.facebook.com/',
      'sec-ch-ua':
        '".Not/A)Brand";v="99", "Google Chrome";v="103", "Chromium";v="103"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    };
    const response = await axios.get(
      'https://business.facebook.com/content_management',
      { headers }
    );
    const token = response.data.match(/"accessToken":\s*"([^"]+)"/);
    if (token && token[1]) {
      return token[1];
    }
  } catch (error) {
    return null;
  }
}

// ============================================================
// COOKIE CONVERSION
// ============================================================

async function convertCookie(cookie) {
  return new Promise((resolve, reject) => {
    try {
      const cookies = JSON.parse(cookie);
      const sbCookie = cookies.find((c) => c.key === 'sb');
      if (!sbCookie) {
        reject('Detect invalid appstate please provide a valid appstate');
        return;
      }
      const sbValue = sbCookie.value;
      const data = `sb=${sbValue}; ${cookies
        .slice(1)
        .map((c) => `${c.key}=${c.value}`)
        .join('; ')}`;
      resolve(data);
    } catch (error) {
      reject('Error processing appstate please provide a valid appstate');
    }
  });
}

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
