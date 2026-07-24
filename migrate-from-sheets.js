/**
 * Marsella Conecta — one-time migration from Google Sheets to Supabase.
 *
 * Run this ONCE, locally, from your own machine — never deploy it or put
 * the service role key in the frontend. It:
 *   1. Pulls the two published Google Sheet CSVs (businesses + neighbors)
 *   2. Inserts businesses into `businesses` + `business_private`
 *   3. Inserts neighbor accounts into `profiles` WITHOUT passwords
 *      (auth_user_id stays null, migrated = true) — they'll get linked
 *      automatically the next time they sign up with a new password.
 *
 * Setup:
 *   npm init -y
 *   npm install @supabase/supabase-js
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node migrate-from-sheets.js
 *
 * Get SUPABASE_SERVICE_ROLE_KEY from Project Settings > API > service_role
 * (NOT the anon key — this script needs to bypass RLS to backfill data).
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Same published CSV endpoints the old site used to read from.
const BUSINESS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRtiBEyirRS73NI23sRAllDT7g3aphl5uYmhDIRHKhzwjYDZD8c0YmNv19WfkBgHXZxTLlS5HnROUOz/pub?gid=0&single=true&output=csv';
const USER_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRtiBEyirRS73NI23sRAllDT7g3aphl5uYmhDIRHKhzwjYDZD8c0YmNv19WfkBgHXZxTLlS5HnROUOz/pub?gid=596180293&single=true&output=csv';

function normalizeKey(k) {
  return k.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_').toLowerCase();
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const rawHeaders = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const headers = rawHeaders.map(normalizeKey);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const cols = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim().replace(/^"|"$/g, ''); });
    return obj;
  });
}

function get(row, ...candidates) {
  for (const c of candidates) {
    const key = normalizeKey(c);
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return '';
}

async function migrateBusinesses() {
  console.log('Fetching business sheet...');
  const res = await fetch(BUSINESS_CSV_URL);
  const rows = parseCSV(await res.text());
  console.log(`Found ${rows.length} business rows.`);

  let ok = 0, skipped = 0;
  for (const row of rows) {
    const nombre = get(row, 'Nombre');
    if (!nombre) { skipped++; continue; }

    const estadoRaw = (get(row, 'Estado') || '').toLowerCase();
    const estado = ['activo', 'verificado', 'active'].includes(estadoRaw)
      ? 'Activo'
      : (estadoRaw.includes('rechaz') ? 'Rechazado' : 'Pendiente Validacion');

    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .insert({
        nombre,
        categoria: get(row, 'Categoría', 'Categoria'),
        sub_categoria: get(row, 'Sub_Categoria', 'Sub-Categoria', 'Subcategoria'),
        barrio: get(row, 'Barrio'),
        telefono: get(row, 'Teléfono', 'Telefono'),
        descripcion: get(row, 'Descripción', 'Descripcion'),
        estrellas: parseFloat(get(row, 'Estrellas')) || 0,
        horario: get(row, 'Horario'),
        plan: get(row, 'Plan') || 'Gratuito',
        origen: get(row, 'Origen'),
      })
      .select('id')
      .single();

    if (bizErr) { console.warn(`  ! Failed to insert "${nombre}":`, bizErr.message); skipped++; continue; }

    // The review-status trigger forces new inserts to "Pendiente Validacion" —
    // if the sheet had it already marked Activo/Rechazado, restore that status
    // now via a service_role update (trigger allows service_role to set it).
    if (estado !== 'Pendiente Validacion') {
      await supabase.from('businesses').update({ estado }).eq('id', biz.id);
    }

    const propietario = get(row, 'Propietario');
    const dui = get(row, 'DUI');
    const email = get(row, 'Email');
    if (propietario || dui || email) {
      await supabase.from('business_private').insert({
        business_id: biz.id,
        propietario: propietario || null,
        dui: dui || null,
        email: email || null,
      });
    }
    ok++;
  }
  console.log(`Businesses migrated: ${ok} ok, ${skipped} skipped.`);
}

async function migrateProfiles() {
  console.log('Fetching neighbor sheet...');
  const res = await fetch(USER_CSV_URL);
  const rows = parseCSV(await res.text());
  console.log(`Found ${rows.length} neighbor rows.`);

  let ok = 0, skipped = 0;
  for (const row of rows) {
    const email = get(row, 'Correo Electronico', 'Correo Electrónico').toLowerCase();
    if (!email) { skipped++; continue; }

    // Passwords are intentionally NOT migrated. auth_user_id stays null;
    // the person will get linked automatically the next time they sign
    // up with a fresh password (see handle_new_user trigger).
    const { error } = await supabase.from('profiles').insert({
      email,
      nombre: get(row, 'Nombre'),
      apellido: get(row, 'Apellido'),
      whatsapp: get(row, 'Numero Whatsapp', 'Número Whatsapp'),
      quartier: get(row, 'Quartier'),
      source: get(row, 'Donde nos encontraste'),
      estado: get(row, 'Estado') || 'Activo',
      migrated: true,
    });

    if (error) {
      if (error.code === '23505') { skipped++; continue; } // duplicate email, fine
      console.warn(`  ! Failed to insert ${email}:`, error.message);
      skipped++;
      continue;
    }
    ok++;
  }
  console.log(`Profiles migrated: ${ok} ok, ${skipped} skipped.`);
}

(async () => {
  await migrateBusinesses();
  await migrateProfiles();
  console.log('\nDone. Every migrated neighbor must reset their password by');
  console.log('signing up again with the same email on the new site.');
})();
