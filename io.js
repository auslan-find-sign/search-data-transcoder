import fs from 'node:fs/promises'
import nodeURL from 'node:url'
import path from 'node:path'
import fetch from 'node-fetch'

export async function read (url) {
  if (url.protocol === 'file:') {
    const buffer = await fs.readFile(url)
    return buffer
  } else {
    const response = await fetch(url)
    const data = new Uint8Array(await response.arrayBuffer())
    return data
  }
}

export async function write (url, data) {
  if (url.protocol === 'file:') {
    // ensure folder exists
    const folderPath = path.dirname(nodeURL.fileURLToPath(url))
    await fs.mkdir(folderPath, { recursive: true })
    await fs.writeFile(url, data)
    return true
  } else {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: data
    })
    if (!response.ok) throw new Error(`file write failed: ${response.status}`)
  }
}