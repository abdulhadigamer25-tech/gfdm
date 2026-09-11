import { createServer } from 'node:http'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.API_PORT || 8787)
const dataFile = join(dirname(fileURLToPath(import.meta.url)), 'data', 'users.json')
const sessions = new Map()

async function readUsers() {
  try {
    return JSON.parse(await readFile(dataFile, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return []
  }
}

async function saveUsers(users) {
  await mkdir(dirname(dataFile), { recursive: true })
  await writeFile(dataFile, JSON.stringify(users, null, 2))
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

function verifyPassword(password, stored) {
  const [salt, key] = stored.split(':')
  const derived = scryptSync(password, salt, 64)
  return timingSafeEqual(derived, Buffer.from(key, 'hex'))
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': process.env.WEB_ORIGIN || 'http://localhost:5173', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type', ...headers })
  response.end(JSON.stringify(body))
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt }
}

async function sendVerificationEmail(email, code) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Email delivery is not configured. Set RESEND_API_KEY before creating accounts.')
  }
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || 'ViperTech <onboarding@resend.dev>', to: [email], subject: 'Your ViperTech verification code', html: `<p>Your ViperTech verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 15 minutes.</p>` }),
  })
  if (!result.ok) throw new Error('Email provider rejected the verification email.')
}

async function issueVerification(user) {
  const code = String(Math.floor(100000 + Math.random() * 900000))
  user.verificationCode = hashPassword(code)
  user.verificationExpires = Date.now() + 15 * 60 * 1000
  await sendVerificationEmail(user.email, code)
}

function cookieOptions(token, maxAge = 60 * 60 * 24 * 30) {
  return `viper_session=${token}; HttpOnly; ${process.env.WEB_ORIGIN ? 'Secure; SameSite=None' : 'SameSite=Lax'}; Path=/; Max-Age=${maxAge}`
}

function getToken(request) {
  const cookies = request.headers.cookie || ''
  return cookies.split(';').map(value => value.trim()).find(value => value.startsWith('viper_session='))?.split('=')[1]
}

async function body(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return JSON.parse(raw || '{}')
}

const api = createServer(async (request, response) => {
  if (!request.url.startsWith('/api/')) return send(response, 404, { error: 'Not found' })
  if (request.method === 'OPTIONS') return send(response, 204, {})
  try {
    const users = await readUsers()
    const path = request.url.split('?')[0]
    if (request.method === 'GET' && path === '/api/auth/me') {
      const userId = sessions.get(getToken(request))
      const user = users.find(item => item.id === userId)
      return user ? send(response, 200, { user: publicUser(user) }) : send(response, 200, { user: null })
    }
    if (request.method === 'POST' && path === '/api/auth/signup') {
      const { name, email, password } = await body(request)
      const normalizedEmail = String(email || '').trim().toLowerCase()
      if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(normalizedEmail) || String(password || '').length < 8) return send(response, 400, { error: 'Enter a name, a valid email, and a password with at least 8 characters.' })
      if (users.some(user => user.email === normalizedEmail)) return send(response, 409, { error: 'An account with that email already exists. Sign in instead.' })
      const user = { id: randomUUID(), name: name.trim(), email: normalizedEmail, password: hashPassword(password), verified: false, createdAt: new Date().toISOString() }
      await issueVerification(user)
      users.push(user)
      await saveUsers(users)
      return send(response, 201, { verificationRequired: true, email: normalizedEmail })
    }
    if (request.method === 'POST' && path === '/api/auth/resend') {
      const { email } = await body(request)
      const user = users.find(item => item.email === String(email || '').trim().toLowerCase())
      if (!user || user.verified) return send(response, 400, { error: 'No unverified account was found for that email.' })
      await issueVerification(user)
      await saveUsers(users)
      return send(response, 200, { verificationRequired: true, email: user.email })
    }
    if (request.method === 'POST' && path === '/api/auth/verify') {
      const { email, code } = await body(request)
      const user = users.find(item => item.email === String(email || '').trim().toLowerCase())
      if (!user || user.verified || !user.verificationCode || user.verificationExpires < Date.now() || !verifyPassword(String(code || ''), user.verificationCode)) return send(response, 400, { error: 'That verification code is invalid or expired.' })
      user.verified = true
      delete user.verificationCode
      delete user.verificationExpires
      await saveUsers(users)
      const token = randomBytes(32).toString('hex')
      sessions.set(token, user.id)
      return send(response, 200, { user: publicUser(user) }, { 'Set-Cookie': cookieOptions(token) })
    }
    if (request.method === 'POST' && path === '/api/auth/signin') {
      const { email, password } = await body(request)
      const user = users.find(item => item.email === String(email || '').trim().toLowerCase())
      if (!user || !verifyPassword(String(password || ''), user.password)) return send(response, 401, { error: 'Email or password is incorrect.' })
      if (!user.verified) return send(response, 403, { error: 'Verify your email before signing in.', verificationRequired: true, email: user.email })
      const token = randomBytes(32).toString('hex')
      sessions.set(token, user.id)
      return send(response, 200, { user: publicUser(user) }, { 'Set-Cookie': cookieOptions(token) })
    }
    if (request.method === 'POST' && path === '/api/auth/signout') {
      sessions.delete(getToken(request))
      return send(response, 200, { ok: true }, { 'Set-Cookie': cookieOptions('', 0) })
    }
    return send(response, 404, { error: 'Not found' })
  } catch (error) {
    console.error(error)
    const message = error.message.includes('Email delivery') || error.message.includes('Email provider') ? error.message : 'Something went wrong. Please try again.'
    return send(response, 503, { error: message })
  }
})

api.listen(port, () => console.log(`Auth API listening on http://localhost:${port}`))
