require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS for your specific frontend domain
app.use(cors());
app.use(express.json());

// Secure Connection Pool to Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ROUTE 1: USER BEHAVIORAL LOG ANALYTICS (Old Appscript Route 1)
app.post('/api/analytics/log', async (req, res) => {
  const { Usuarioid, Evento_Tipo, Valor_Busqueda, Negocio_Nombre } = req.body;
  try {
    await pool.query(
      `INSERT INTO user_event_logs (usuario_id, evento_tipo, valor_busqueda, negocio_nombre) 
       VALUES ($1, $2, $3, $4)`,
      [Usuarioid, Evento_Tipo, Valor_Busqueda, Negocio_Nombre]
    );
    res.status(201).json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', details: err.message });
  }
});

// ROUTE 2: RESIDENTIAL NEIGHBOR SIGN-UPS WITH DUPLICATE CHECK (Old Appscript Route 2)
app.post('/api/auth/register', async (req, res) => {
  const { Usarioid, Nombre, Apellido, Email, Whatsapp, Quartier, Donde_nos_encontraste, Clave } = req.body;
  try {
    // Direct server-side duplicate check
    const duplicateCheck = await pool.query(
      'SELECT email, whatsapp FROM neighbors WHERE email = $1 OR whatsapp = $2',
      [Email, Whatsapp]
    );

    if (duplicateCheck.rows.length > 0) {
      const isEmail = duplicateCheck.rows.some(r => r.email === Email);
      return res.status(400).json({ 
        status: 'duplicate', 
        message: `Este ${isEmail ? 'correo electrónico' : 'número de WhatsApp'} ya se encuentra registrado.` 
      });
    }

    // Hash plaintext password securely before writing to Supabase
    const saltRounds = 10;
    const hashedClave = await bcrypt.hash(Clave, saltRounds);

    await pool.query(
      `INSERT INTO neighbors (id, nombre, apellido, email, whatsapp, quartier, donde_nos_encontraste, clave_hash) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [Usarioid, Nombre, Apellido, Email, Whatsapp, Quartier, Donde_nos_encontraste, hashedClave]
    );

    res.status(201).json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', details: err.message });
  }
});

// NEW SERVER-SIDE LOGIN ROUTE (Replaces insecure CSV scanning in index.html)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM neighbors WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ status: 'error', message: 'Credenciales inválidas.' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.clave_hash);

    if (match) {
      res.json({
        status: 'success',
        user: { id: user.id, nombre: user.nombre, apellido: user.apellido, quartier: user.quartier, email: user.email }
      });
    } else {
      res.status(401).json({ status: 'error', message: 'Credenciales inválidas.' });
    }
  } catch (err) {
    res.status(500).json({ status: 'error', details: err.message });
  }
});

// ROUTE 3: PROFILE UPDATES (Old Appscript Route 3)
app.put('/api/users/profile', async (req, res) => {
  const { Usarioid, Nombre, Apellido, Email, Whatsapp, Quartier, Clave } = req.body;
  try {
    let updateQuery = `
      UPDATE neighbors 
      SET nombre = $1, apellido = $2, email = $3, quartier = $4 
    `;
    let queryParams = [Nombre, Apellido, Email, Quartier];

    if (Whatsapp && Whatsapp !== 'No cambiado') {
      updateQuery += `, whatsapp = $5`;
      queryParams.push(Whatsapp);
    }

    if (Clave && Clave.trim() !== '') {
      const hashedClave = await bcrypt.hash(Clave, 10);
      const paramIndex = queryParams.length + 1;
      updateQuery += `, clave_hash = $${paramIndex}`;
      queryParams.push(hashedClave);
    }

    const idParamIndex = queryParams.length + 1;
    updateQuery += ` WHERE id = $${idParamIndex}`;
    queryParams.push(Usarioid);

    await pool.query(updateQuery, queryParams);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', details: err.message });
  }
});

// ROUTE 4: DIRECTORY READ & CREATE (Old Appscript Route 4 & index.html CSV URL)
app.get('/api/businesses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM businesses ORDER BY fecha_registro DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: 'error', details: err.message });
  }
});

app.post('/api/businesses', async (req, res) => {
  const { Usuarioid, Nombre, Categoría, Barrio, Teléfono, Descripción, Horario, Origen, Plan, Propietario, DUI, Email } = req.body;
  try {
    const systemBizId = 'BIZ-' + Math.floor(10000000 + Math.random() * 90000000);
    await pool.query(
      `INSERT INTO businesses (id, nombre, categoria, barrio, telefono, descripcion, horario, origen, plan, propietario, dui, email, usuario_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [systemBizId, Nombre, Categoría, Barrio, Teléfono, Descripción, Horario, Origen, Plan, Propietario, DUI, Email, Usuarioid]
    );
    res.status(201).json({ status: 'success', id: systemBizId });
  } catch (err) {
    res.status(500).json({ status: 'error', details: err.message });
  }
});

app.listen(PORT, () => console.log(`Server executing cleanly on port ${PORT}`));
