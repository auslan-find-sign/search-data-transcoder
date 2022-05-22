# search-data-transcoder
Transcodes find-sign "search-data" format in to "encoded-search-data" format with multiple codec/resolution variants. This data can be used to directly build web interfaces like auslan-find-sign/find-sign-website. Audio tracks are stripped from videos, and clipping rules are implemented.

This follows the same format as search-data, but media is transcoded so each media entry like:

```json
{ "method": "fetch", "url": "path/to/media.mkv", "version": "1234" }
```

is replaced with a MediaSet:

```json
{
  "type": "video" | "audio",
  "source": { "method": "fetch", "url": "path/to/media.mkv", "version": "1234" },
  "thumbnail": "path/to/thumbnail.webp",
  "timestamp": number,
  "encodes": [
	{ "type": "video/mp4; codecs=\"avc1.4d002a\"", "width": 512, "height": 288, "src": "path/to/encode.mp4" },
    { "type": "video/webm; codecs=\"vp8, vorbis\"", "width": 1024, "height": 576, "src": "path/to/encode.webm" }
  ]
}
```


`type` is either video or audio. Find sign doesn't use audio.

`source` is a copy of the thing that was encoded, to preserve url and version for cache invalidation when the source changes.

`timestamp` is an epochMs remembering when the video was converted. This might be used in the future to re-encode media after a cache duration, to take advantage of advances in encoder technology.

`encodes` is a list of `<source>` elements that can be constructed inside a `<video>` or `<audio>` tag to play the encodes in a web browser. `src` may contain relative paths, so should be interpreted relative to the location of the encoded-search-data.json file.
