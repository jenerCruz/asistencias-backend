import { App } from '@octokit/app';
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';

const MyOctokit = Octokit.plugin(paginateRest, restEndpointMethods);

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
  const app = new App({
    appId: process.env.APP_ID,
    privateKey: process.env.APP_PRIVATE_KEY
  });
  return await app.getInstallationOctokit(Number(process.env.INSTALLATION_ID), {
    Octokit: MyOctokit
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Método no permitido' });
  }

  try {
    const {
      empleadoId,
      tipo,
      notas,
      filename,
      contentBase64
    } = req.body;

    if (!empleadoId || !tipo || !filename || !contentBase64) {
      return res.status(400).json({ message: 'Faltan campos requeridos.' });
    }

    if (!['entrada', 'salida'].includes(tipo)) {
      return res.status(400).json({ message: 'Tipo inválido.' });
    }

    const buf = Buffer.from(contentBase64, 'base64');
    if (buf.length > Number(process.env.MAX_SIZE_BYTES || 26214400)) {
      return res.status(400).json({ message: 'Archivo demasiado grande.' });
    }

    const ext = filename.split('.').pop().toLowerCase();
    const allowed = ['jpg', 'jpeg', 'png', 'heic', 'pdf'];
    if (!allowed.includes(ext)) {
      return res.status(400).json({ message: 'Extensión no permitida.' });
    }

    const octokit = await getOctokit();

    // Validar empleado desde employees.json
    let empleadoNombre = empleadoId;
    try {
      const emp = await octokit.rest.repos.getContent({
        owner: process.env.REPO_OWNER,
        repo: process.env.REPO_NAME,
        path: 'docs/employees.json',
        ref: process.env.DEFAULT_BRANCH || 'main'
      });
      const content = Buffer.from(emp.data.content, 'base64').toString('utf8');
      const list = JSON.parse(content);
      const found = list.find(e => e.id === empleadoId);
      if (!found) return res.status(400).json({ message: 'Empleado no válido.' });
      empleadoNombre = found.nombre;
    } catch (_) {}

    // Crear rama
    const { date, time } = todayParts();
    const branchName = `evidencia/${sanitizeSegment(empleadoId)}/${date}-${time}`;
    const repo = await octokit.rest.repos.get({
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME
    });
    const baseRef = `heads/${repo.data.default_branch || process.env.DEFAULT_BRANCH}`;
    const base = await octokit.rest.git.getRef({
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
      ref: baseRef
    });

    await octokit.rest.git.createRef({
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
      ref: `refs/heads/${branchName}`,
      sha: base.data.object.sha
    });

    // Subir archivo y metadatos
    const safeEmp = sanitizeSegment(empleadoId);
    const safeFile = filename.replace(/[\\/]+/g, '_').slice(0, 120);
    const tipoTag = tipo === 'entrada' ? 'ENTRADA' : 'SALIDA';
    const dir = `evidencias/${safeEmp}/${date}`;
    const filePath = `${dir}/${tipo}-${time}-${safeFile}`;
    const metaPath = `${dir}/${tipo}-${time}-meta.json`;
    const meta = {
      empleadoId,
      empleadoNombre,
      tipo,
      notas: (notas || '').trim(),
      fecha: date,
      hora: time,
      archivo: safeFile,
      version: 1
    };

    const message = `[${tipoTag}] ${empleadoNombre} (${empleadoId}) - ${date} ${time} - ${safeFile}`;

    await octokit.rest.repos.createOrUpdateFileContents({
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
      branch: branchName,
      path: filePath,
      message,
      content: contentBase64
    });

    await octokit.rest.repos.createOrUpdateFileContents({
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
      branch: branchName,
      path: metaPath,
      message: `${message} (metadata)`,
      content: Buffer.from(JSON.stringify(meta, null, 2), 'utf8').toString('base64')
    });

    // Crear Pull Request
    const prTitle = `${tipoTag}: ${empleadoNombre} (${empleadoId}) - ${date}`;
    const pr = await octokit.rest.pulls.create({
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
      head: branchName,
      base: repo.data.default_branch || process.env.DEFAULT_BRANCH,
      title: prTitle,
      body: `Evidencia subida automáticamente.\n\n- Empleado: ${empleadoNombre} (${empleadoId})\n- Tipo: ${tipo}\n- Fecha: ${date}\n- Hora: ${time}\n- Notas: ${meta.notas || 'N/A'}`
    });

    // Etiqueta opcional
    try {
      await octokit.rest.issues.addLabels({
        owner: process.env.REPO_OWNER,
        repo: process.env.REPO_NAME,
        issue_number: pr.data.number,
        labels: ['evidencia']
      });
    } catch (_) {}

    return res.status(201).json({ ok: true, prUrl: pr.data.html_url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'Error interno al procesar la evidencia.' });
  }
}
