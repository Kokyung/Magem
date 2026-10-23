# Size limits

[← Back to README](../README.en.md)

| Item | Limit | When exceeded |
|---|---|---|
| Photos to index | About 268 megapixels (e.g. 16,384 × 16,384) | Not indexed; listed under "Files that couldn't be processed" in the folders panel |
| Search with an image (pick, drag, paste) | 64 MB | Search fails with a message |
| Image dragged from a web browser | 25 MB, 20 s download | Shows an error such as "The image is too large" |
| Copy files (multi-select) | 10,000 at a time | Shows a notice and keeps the selection |
| Copy a photo to the clipboard | 8,192 px on the long side | Larger ones are scaled to 8,192 px when copied (the original file is untouched) |

- The pixel limit is the image library's (sharp) default safeguard. Regular camera and phone photos (100 MP class or less) aren't affected.
- Videos have no file-size limit. Instead, at most 120 frames are indexed, every 2–30 seconds depending on length.
