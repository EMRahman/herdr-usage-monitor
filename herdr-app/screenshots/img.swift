// Image steps for capture.ts, on macOS's own CoreGraphics so nothing needs installing:
//
//   img crop <in.png> <x> <y> <w> <h> <out.png>
//   img paste <src.png> <x> <y> <w> <h> <scale> <at-x> <at-y> <dst.png>
//
// paste draws the source rect scaled at (at-x, at-y) over dst, in place. Only whole pixels inside
// the scaled rect are replaced, so its edges, which sit on a card's plain background, leave no seam.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func load(_ path: String) -> CGImage {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("Couldn't read \(path)")
  }
  return image
}

func save(_ image: CGImage, _ path: String) {
  guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                                   UTType.png.identifier as CFString, 1, nil) else {
    fatalError("Couldn't write \(path)")
  }
  CGImageDestinationAddImage(dest, image, nil)
  if !CGImageDestinationFinalize(dest) { fatalError("Couldn't write \(path)") }
}

func canvas(_ width: Int, _ height: Int) -> CGContext {
  CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: srgb, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func pixels(_ ctx: CGContext) -> UnsafeMutablePointer<UInt8> {
  ctx.data!.bindMemory(to: UInt8.self, capacity: ctx.width * ctx.height * 4)
}

let args = CommandLine.arguments
func number(_ i: Int) -> Double {
  guard i < args.count, let value = Double(args[i]) else { fatalError("Expected a number at argument \(i)") }
  return value
}

switch args.count > 1 ? args[1] : "" {
case "crop":
  let rect = CGRect(x: number(3), y: number(4), width: number(5), height: number(6))
  guard let piece = load(args[2]).cropping(to: rect) else { fatalError("Crop is outside the image") }
  save(piece, args[7])
case "paste":
  let rect = CGRect(x: number(3), y: number(4), width: number(5), height: number(6))
  let (scale, atX, atY, path) = (number(7), number(8), number(9), args[10])
  guard let piece = load(args[2]).cropping(to: rect) else { fatalError("Source rect is outside the image") }
  let target = load(path)
  let (w, h) = (target.width, target.height)
  let out = canvas(w, h)
  out.draw(target, in: CGRect(x: 0, y: 0, width: w, height: h))
  let layer = canvas(w, h)
  layer.interpolationQuality = .high
  let (dw, dh) = (rect.width * scale, rect.height * scale)
  layer.draw(piece, in: CGRect(x: atX, y: Double(h) - atY - dh, width: dw, height: dh))
  let (into, from) = (pixels(out), pixels(layer))
  for y in Int(atY.rounded(.up))..<Int((atY + dh).rounded(.down)) {
    for x in Int(atX.rounded(.up))..<Int((atX + dw).rounded(.down)) {
      let i = (y * w + x) * 4
      for c in 0..<4 { into[i + c] = from[i + c] }
    }
  }
  save(out.makeImage()!, path)
default:
  fatalError("Usage: img crop <in> <x> <y> <w> <h> <out> | img paste <src> <x> <y> <w> <h> <scale> <at-x> <at-y> <dst>")
}
