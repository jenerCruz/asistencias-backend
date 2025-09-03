import express from 'express';
import cors from 'cors';
import { App } from '@octokit/app';
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';

const MyOctokit = Octokit.plugin(paginateRest, restEndpointMethods);
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '30mb' }));

// Configuración
const {
  APP_ID,
  APP_PRIVATE_KEY, // -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
  INSTALLATION_ID,  // de tu App instalada en el repositorio
  REPO_OWNER,       // p.ej. "tu-org-o-user"
  REPO_NAME,        // p.ej. "asistencias-evidencias"
  DEFAULT_BRANCH = 'main',
  MAX_SIZE_BYTES = `${25 * 1024 * 1024}`
} = process.env;

// Utilidades
function todayParts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}${mi}${ss}` };
}
function sanitizeSegment(s) {
  return s.toLowerCase().replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 64);
}

async function getOctokit() {
  const app = new App({ appId: APP_ID, privateKey: APP_PRIVATE_KEY });
  return await app.getInstallationOctokit(Number(INSTALLATION_ID), { Octokit: MyOctokit });
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/upload', async (req, res) => {
  try {
    const { empleadoId, tipo, notas, filename, contentBase64 } = req.body || {};
    if (!empleadoId || !tipo || !filename || !contentBase64) {
      return res.status(400).json({ message: 'Faltan campos requeridos.' });
    }
    if (!['entrada', 'salida'].includes(tipo)) {
      return res.status(400).json({ message: 'Tipo inválido.' });
    }
    const buf = Buffer.from(contentBase64, 'base64');
    if (buf.length > Number(MAX_SIZE_BYTES)) {
      return res.status(400).json({ message: 'Archivo demasiado grande.' });
    }
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const allowed = ['jpg','jpeg','png','heic','pdf'];
    if (!allowed.includes(ext)) {
      return res.status(400).json({ message: 'Extensión no permitida.' });
    }

    const octokit = await getOctokit();

    // Obtiene employees.json para validar empleado y obtener nombre
    let empleadoNombre = empleadoId;
    try {
      const emp = await octokit.rest.repos.getContent({
        owner: REPO_OWNER, repo: REPO_NAME, path: 'docs/employees.json', ref: DEFAULT_BRANCH
      });
      const content = Buffer.from(emp.data.content, 'base64').toString('utf8');
      const list = JSON.parse(content);
      const found = list.find(e => e.id === empleadoId);
      if (!found) return res.status(400).json({ message: 'Empleado no válido.' });
      empleadoNombre = found.nombre;
    } catch (_) {
      // Si no existe, sigue con el id
    }

    // Crea rama para la evidencia
    const { data: repo } = await octokit.rest.repos.get({ owner: REPO_OWNER, repo: REPO_NAME });
    const baseRef = `heads/${repo.default_branch || DEFAULT_BRANCH}`;
    const { data: base } = await octokit.rest.git.getRef({ owner: REPO_OWNER, repo: REPO_NAME, ref: baseRef });

    const { date, time } = todayParts();
    const branchName = `evidencia/${sanitizeSegment(empleadoId)}/${date}-${time}`;
    await octokit.rest.git.createRef({
      owner: REPO_OWNER, repo: REPO_NAME,
      ref: `refs/heads/${branchName}`,
      sha: base.object.sha
    });

    // Ruta de archivo y metadata
    const safeEmp = sanitizeSegment(empleadoId);
    const safeFile = filename.replace(/[\\/]+/g, '_').slice(0, 120);
    const tipoTag = tipo === 'entrada' ? 'ENTRADA' : 'SALIDA';
    const dir = `evidencias/${safeEmp}/${date}`;
    const filePath = `${dir}/${tipo}-${time}-${safeFile}`;
    const metaPath = `${dir}/${tipo}-${time}-meta.json`;
    const meta = {
      empleadoId, empleadoNombre, tipo, notas: (notas || '').trim(),
      fecha: date, hora: time, archivo: safeFile, version: 1
    };

    // Asegura carpeta (Git no requiere carpetas, solo archivos)
    const message = `[${tipoTag}] ${empleadoNombre} (${empleadoId}) - ${date} ${time} - ${safeFile}`;
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: REPO_OWNER, repo: REPO_NAME, branch: branchName, path: filePath,
      message, content: contentBase64
    });
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: REPO_OWNER, repo: REPO_NAME, branch: branchName, path: metaPath,
      message: `${message} (metadata)`,
      content: Buffer.from(JSON.stringify(meta, null, 2), 'utf8').toString('base64')
    });

    // Abre PR
    const prTitle = `${tipoTag}: ${empleadoNombre} (${empleadoId}) - ${date}`;
    const pr = await octokit.rest.pulls.create({
      owner: REPO_OWNER, repo: REPO_NAME,
      head: branchName, base: repo.default_branch || DEFAULT_BRANCH,
      title: prTitle, body: `Evidencia subida automáticamente.\n\n- Empleado: ${empleadoNombre} (${empleadoId})\n- Tipo: ${tipo}\n- Fecha: ${date}\n- Hora: ${time}\n- Notas: ${meta.notas || 'N/A'}`
    });

    // Etiqueta para que el workflow la identifique si quieres reglas extras
    try {
      await octokit.rest.issues.addLabels({
        owner: REPO_OWNER, repo: REPO_NAME, issue_number: pr.data.number, labels: ['evidencia']
      });
    } catch (_) {}

    return res.status(201).json({ ok: true, prUrl: pr.data.html_url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'Error interno al procesar la evidencia.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en :${PORT}`));
