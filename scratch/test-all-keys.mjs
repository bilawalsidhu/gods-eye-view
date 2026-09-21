import fs from 'node:fs';

// Read .env directly
const envContent = fs.readFileSync('.env', 'utf8');
const env = {};
for (const line of envContent.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq > 0) {
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}

const keysToTest = [
  {
    name: 'NVIDIA NIM',
    test: async () => {
      const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
        headers: { Authorization: `Bearer ${env.NVIDIA_API_KEY}` }
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'Groq Cloud',
    test: async () => {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` }
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'Cerebras',
    test: async () => {
      const res = await fetch('https://api.cerebras.ai/v1/models', {
        headers: { Authorization: `Bearer ${env.CEREBRAS_API_KEY}` }
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'Mistral AI',
    test: async () => {
      const res = await fetch('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${env.MISTRAL_API_KEY}` }
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'OpenRouter',
    test: async () => {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` }
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'Google Gemini',
    test: async () => {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`);
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'Cohere',
    test: async () => {
      const res = await fetch('https://api.cohere.com/v2/models', {
        headers: { Authorization: `Bearer ${env.COHERE_API_KEY}` }
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'SambaNova',
    test: async () => {
      const res = await fetch('https://api.sambanova.ai/v1/models', {
        headers: { Authorization: `Bearer ${env.SAMBANOVA_API_KEY}` }
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'Together AI',
    test: async () => {
      const res = await fetch('https://api.together.xyz/v1/models', {
        headers: { Authorization: `Bearer ${env.TOGETHER_API_KEY}` }
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'Requesty',
    test: async () => {
      const res = await fetch('https://router.requesty.ai/v1/models', {
        headers: { Authorization: `Bearer ${env.REQUESTY_API_KEY}` }
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'Manifest',
    test: async () => {
      const res = await fetch('https://app.manifest.build/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.MANIFEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 150) };
    }
  },
  {
    name: 'Cesium ion Token',
    test: async () => {
      const res = await fetch(`https://api.cesium.com/v1/me?access_token=${env.CESIUM_ION_TOKEN}`);
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'NASA FIRMS',
    test: async () => {
      const res = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/country/csv/${env.FIRMS_MAP_KEY}/MODIS_NRT/USA/1`);
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'TomTom Traffic',
    test: async () => {
      const res = await fetch(`https://api.tomtom.com/traffic/services/4/incidentDetails/s3/10/10/10/10/-1/pbf?key=${env.TOMTOM_API_KEY}`);
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  },
  {
    name: 'OpenSky OAuth',
    test: async () => {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.OPENSKY_CLIENT_ID || '',
        client_secret: env.OPENSKY_CLIENT_SECRET || ''
      });
      const res = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 100) };
    }
  }
];

async function run() {
  console.log('--- AUDITING ALL APIS AND KEYS IN .env ---\n');
  for (const item of keysToTest) {
    try {
      const result = await item.test();
      console.log(`[${result.ok ? 'WORKING' : 'FAILED'}] ${item.name} (Status: ${result.status})`);
      if (!result.ok) {
        console.log(`       Output: ${result.text.replace(/\s+/g, ' ')}`);
      }
    } catch (e) {
      console.log(`[ERROR] ${item.name}: ${e.message}`);
    }
  }
}

run();
