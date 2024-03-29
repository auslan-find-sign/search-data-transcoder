import fs from 'fs'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { read, write } from './io.js'
import hbjs from 'handbrake-js'
import { cwd } from 'process'
import { pathToFileURL } from 'url'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { tmpdir } from 'os'
import ffmpeg from 'ffmpeg-static'
import genThumbnail from 'simple-thumbnail'
import ffprobe from 'getmeta-ffprobe'
import parseDuration from 'parse-duration'

const codecPresets = {
  vp9: 'slow', // very slow is so so slow in vp9
  x264: 'veryslow'
}

// make strings filename safe
function idToFilename (id) {
  return id.replace(/[^-a-zA-Z0-9.]/gmi, (match) => {
    if (match === ' ') {
      return '_'
    } else {
      const charnum = match.charCodeAt(0)
      return `_-${charnum.toString(36)}-_`
    }
  })
}

function sourceMatch(left, right) {
  if (left.version !== right.version) return false
  if (left.url !== right.url) return false
  return true
}

const args = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: 'input is required',
    description: 'url or relative path for where to read search-data.json input file'
  })
  .option('output', {
    alias: 'o',
    type: 'string',
    demandOption: 'output is required',
    description: 'url or relative path for where to write encoded-search-data.json file'
  })
  .option('formats', {
    alias: 'f',
    type: 'string',
    description: 'Formats to transcode in to, comma seperated list of [container]:[codec]:[quality]@[horizontal]x[vertical]',
    default: 'mp4:x264:22.0@512x288,webm:vp9:32.0@1024x576'
  })
  .option('write-continuously', {
    type: 'boolean',
    description: 'Write the output json after every entry is encoded'
  })
  .option('expire-encodes', {
    type: 'string',
    description: 'Redo the encodes, takes a time like "1w" or "1h" to specify how old is too old',
  })
  .parse()

const inputURL = new URL(args.input, pathToFileURL(join(cwd(), 'placeholder-file')))
const outputURL = new URL(args.output, pathToFileURL(join(cwd(), 'placeholder-file')))
const searchData = JSON.parse(Buffer.from(await read(inputURL)).toString('utf-8'))
let prevEncode = {}
try {
  prevEncode = JSON.parse(Buffer.from(await read(outputURL) || '{}').toString('utf-8'))
} catch (err) {
  console.warn(err)
}
const outputData = {}

// strip out any encodes that are expired
const maxEncodeAge = args.expireEncodes ? Date.now() - parseDuration(args.expireEncodes) : undefined
if (maxEncodeAge !== undefined) {
  for (const id in prevEncode) {
    const encode = prevEncode[id]
    if (encode.timestamp < maxEncodeAge) {
      encode.thumbnail = undefined
      encode.timestamp = Date.now()
      encode.encodes = []
    }
  }
}

const encodeFormats = args.formats.split(',').map(x => {
  const [format, res] = x.split('@')
  const [container, codec, quality] = format.split(':')
  const [width, height] = res.split('x').map(x => parseInt(x))
  return { container, codec, quality: parseFloat(quality), width, height }
})

for (const id in searchData) {
  const entry = searchData[id]
  let didEncodeWork = false
  console.log(`working on ${id}: ${entry.title}`)

  // list of temp files to free when we're done
  const inputFileCache = new Map() // maps input url to local file path

  const outputEntry = outputData[id] = { ...entry, media: [] }

  for (const [mediaIdx, mediaEntry] of entry.media.map((entry, idx) => [idx, entry])) {
    const { method, url, clipping } = mediaEntry
    if (method !== 'fetch') throw new Error(`Media entry for ${id} doesn’t use fetch method`)
    const mediaURL = new URL(url, inputURL)

    const outputMedia = {
      type: 'video', // audio unimplemented
      source: mediaEntry,
      thumbnail: undefined, // path to thumbnail webp
      timestamp: Date.now(),
      encodes: []
    }

    const prevMedias = ((prevEncode[id] || {}).media || [])

    for (const { container, codec, width, height, quality } of encodeFormats) {
      const prevMedia = prevMedias.find(x => sourceMatch(x.source, mediaEntry))
      const encodeVersion = `${container}:${codec}:${quality}@${width}x${height}`
      if (prevMedia) {
        if (!outputMedia.thumbnail) outputMedia.thumbnail = prevMedia.thumbnail
        const prevEncode = prevMedia.encodes.find(x => {
          return x.version === encodeVersion
        })
        if (prevEncode) {
          outputMedia.timestamp = Math.min(outputMedia.timestamp, prevMedia.timestamp)
          outputMedia.encodes.push(prevEncode)
          continue
        }
      }

      // if we got to this point, we need to grab the input file and do a transcode
      if (!inputFileCache.has(mediaURL.toString())) {
        console.log(`downloading ${mediaURL}`)
        // download the video file to a temporary location
        const ext = mediaURL.pathname.split('.').slice(-1)[0]
        const tempFilename = `search-data-transcoder-${nanoid()}.${ext}`
        const videoData = await read(mediaURL)
        const tempVideoPath = join(tmpdir(), tempFilename)
        await write(pathToFileURL(tempVideoPath), videoData)
        inputFileCache.set(mediaURL.toString(), tempVideoPath)
      }

      const inputVideoPath = inputFileCache.get(mediaURL.toString())
      const outputTempFile = join(tmpdir(), `handbrake-output-${nanoid()}.${container}`)
      console.log(`encoding ${mediaURL} to ${container}:${codec}`)

      const handbrakeOptions = {
        input: inputVideoPath,
        output: outputTempFile,
        format: container,
        encoder: codec,
        maxWidth: width,
        maxHeight: height,
        quality: quality,
        hqdn3d: 'strong',
        'keep-display-aspect': true,
        'non-anamorphic': true,
        audio: 'none',
        'encoder-preset': codecPresets[codec] || 'veryslow',
        optimize: true,
        'align-av': true,
        '2': true, // enable 2-pass encoding
      }
      // if clipping is specified, do it
      if (clipping && typeof clipping === 'object') {
        if (typeof clipping.start === 'number') {
          handbrakeOptions['start-at'] = `duration:${clipping.start}`
        }
        if (typeof clipping.end === 'number') {
          handbrakeOptions['stop-at'] = `duration:${(clipping.end - (clipping.start || 0))}`
        }
      }

      let actualWidth, actualHeight
      try {
         const result = await new Promise((resolve, reject) => {
          const progressFrequency = 2000
          let lastProgress = 0
          let lastPercent = ''
          const instance = hbjs.spawn(handbrakeOptions).on('error', err => {
            // invalid user input, no video found etc
            reject(err)
          }).on('progress', progress => {
            if (Date.now() > lastProgress + progressFrequency && lastPercent !== progress.percentComplete) {
              console.log(`Encode progress: ${progress.percentComplete || 0}%, ETA: ${progress.eta}`)
              lastPercent = progress.percentComplete
              lastProgress = Date.now()
            }
          }).on('complete', () => {
            const match = instance.output.match(/ \+ display dimensions: ([0-9]+) x ([0-9]+)/)
            if (match) {
              const [_, x, y] = match
              resolve({ actualWidth: parseInt(x), actualHeight: parseInt(y) })
            } else {
              reject(instance.output)
            }
          })
        })

        actualWidth = result.actualWidth
        actualHeight = result.actualHeight

        didEncodeWork = true
      } catch (err) {
        console.log('Video encode failed:', err)
        outputEntry.published = false
      }

      if (didEncodeWork) {
        const mediaOutputURL = new URL(outputURL.toString())
        const videoEncodeFilename = `${idToFilename(id)}-${mediaIdx}-${codec}-${actualWidth}x${actualHeight}.${container}`
        mediaOutputURL.pathname = `${mediaOutputURL.pathname.replace(/\.json$/, '')}-media/${videoEncodeFilename}`

        const [pWidth, pHeight, pCodecName] = await ffprobe(outputTempFile, 'stream', 'v', 'width,height,codec_name')
        const [pDuration, pByteSize] = await ffprobe(outputTempFile, 'format', 'v', 'duration,size')

        const encodedData = await read(pathToFileURL(outputTempFile))
        await write(mediaOutputURL, encodedData)
        await fs.promises.rm(outputTempFile)

        outputMedia.encodes.push({
          type: `video/${container}`,
          container,
          width: Number(pWidth),
          height: Number(pHeight),
          codec: pCodecName,
          duration: Number(pDuration),
          byteSize: Number(pByteSize),
          url: `${outputURL.pathname.split('/').slice(-1)[0].replace(/\.json$/, '')}-media/${videoEncodeFilename}`,
          version: encodeVersion,
        })

        console.log('encode complete')
      }
    }

    outputEntry.media.push(outputMedia)
    console.log('entry complete')

    if (!outputMedia.thumbnail) {
      try {
        console.log(`generating thumbnail for ${mediaURL}`)
        const thumbnailTempPath = join(tmpdir(), `thumbnail-${nanoid()}.webp`)
        const inputVideoPath = inputFileCache.get(mediaURL.toString()) || mediaURL.toString()
        await genThumbnail(inputVideoPath, thumbnailTempPath, '?x576', {
          path: ffmpeg.path,
          seek: clipping && typeof clipping.start === 'number' ? `${clipping.start}` : '00:00:00'
        })
        const thumbnailData = await read(pathToFileURL(thumbnailTempPath))
        const thumbnailFilename = `${idToFilename(id)}-${mediaIdx}.webp`
        const thumbnailURL = new URL(outputURL.toString())
        thumbnailURL.pathname = `${thumbnailURL.pathname.replace(/\.json$/, '')}-media/${thumbnailFilename}`
        await write(thumbnailURL, thumbnailData)
        await fs.promises.rm(thumbnailTempPath)
        outputMedia.thumbnail = `${outputURL.pathname.split('/').slice(-1)[0].replace(/\.json$/, '')}-media/${thumbnailFilename}`
        console.log('thumbnail done')
      } catch (err) {
        console.log('Thumbnail error', err)
        outputEntry.published = false
      }
    }

    if (args.writeContinuously && didEncodeWork) {
      console.log(`writing encoded search data to ${outputURL}`)
      await write(outputURL, JSON.stringify({ ...prevEncode, ...outputData }))
    }
  }

  // clean up temp files
  for (const path of inputFileCache.values()) {
    await fs.promises.rm(path)
  }
}

console.log(`writing encoded search data to ${outputURL}`)
await write(outputURL, JSON.stringify(outputData))

console.log('done')
