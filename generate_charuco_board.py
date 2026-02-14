"""
Generate a ChArUco calibration board PDF for A4 paper.

  5x7 squares, AprilTag 36h11, sized to fit A4 with 10mm margins.
  Square size ~34mm, marker size ~25mm.

Usage:
    python generate_charuco_board.py
    python generate_charuco_board.py --output my_board.pdf
    python generate_charuco_board.py --dpi 300
"""

import argparse
import cv2
import numpy as np

# A4 dimensions in mm
A4_W_MM = 210
A4_H_MM = 297
MARGIN_MM = 10

# Board layout
SQUARES_X = 5
SQUARES_Y = 7
ARUCO_DICT = cv2.aruco.DICT_APRILTAG_36h11
BORDER_BITS = 1

# Compute square size to fit printable area
printable_w = A4_W_MM - 2 * MARGIN_MM  # 190mm
printable_h = A4_H_MM - 2 * MARGIN_MM  # 277mm
SQUARE_MM = min(printable_w / SQUARES_X, printable_h / SQUARES_Y)
SQUARE_MM = int(SQUARE_MM)  # round down to whole mm → 38mm
MARKER_MM = int(SQUARE_MM * 0.7)  # ~26mm marker inside 38mm square

SQUARE_LENGTH = SQUARE_MM / 1000.0  # in meters for OpenCV
MARKER_LENGTH = MARKER_MM / 1000.0


def generate_board_image(dpi):
    """Generate the ChArUco board as a NumPy image sized for A4."""
    aruco_dict = cv2.aruco.getPredefinedDictionary(ARUCO_DICT)
    board = cv2.aruco.CharucoBoard(
        (SQUARES_X, SQUARES_Y),
        SQUARE_LENGTH,
        MARKER_LENGTH,
        aruco_dict,
    )
    board.setLegacyPattern(False)

    mm_to_px = dpi / 25.4
    page_w = int(A4_W_MM * mm_to_px)
    page_h = int(A4_H_MM * mm_to_px)
    margin_px = int(MARGIN_MM * mm_to_px)

    board_w = int(SQUARES_X * SQUARE_MM * mm_to_px)
    board_h = int(SQUARES_Y * SQUARE_MM * mm_to_px)

    img = board.generateImage((board_w, board_h), marginSize=0, borderBits=BORDER_BITS)

    # Center on A4 page
    page = np.full((page_h, page_w), 255, dtype=np.uint8)
    offset_x = (page_w - board_w) // 2
    offset_y = (page_h - board_h) // 2
    page[offset_y : offset_y + board_h, offset_x : offset_x + board_w] = img

    # Label at the bottom
    label = (
        f"ChArUco t36h11  {SQUARES_X}x{SQUARES_Y}  "
        f"square:{SQUARE_MM}mm  marker:{MARKER_MM}mm  "
        f"Print at 100% on A4"
    )
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = page_w / 2800
    cv2.putText(
        page, label,
        (margin_px, page_h - margin_px // 2),
        font, font_scale, (0,), max(1, int(font_scale * 2)), cv2.LINE_AA,
    )

    return page, page_w, page_h


def save_pdf(img, path, dpi, page_w_px, page_h_px):
    """Save a grayscale image as a single-page PDF."""
    h, w = img.shape
    import zlib
    compressed = zlib.compress(img.tobytes(), 9)

    # A4 in points (1 inch = 72 pt)
    page_w_pt = A4_W_MM / 25.4 * 72  # ~595.28
    page_h_pt = A4_H_MM / 25.4 * 72  # ~841.89

    objects = []

    def obj(content):
        objects.append(content)
        return len(objects)

    obj("<<\n/Type /Catalog\n/Pages 2 0 R\n>>")
    obj("<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>")
    obj(
        f"<<\n/Type /Page\n/Parent 2 0 R\n"
        f"/MediaBox [0 0 {page_w_pt:.2f} {page_h_pt:.2f}]\n"
        f"/Contents 4 0 R\n/Resources <<\n/XObject << /Img 5 0 R >>\n>>\n>>"
    )
    stream = f"{page_w_pt:.2f} 0 0 {page_h_pt:.2f} 0 0 cm\n/Img Do\n"
    stream_bytes = stream.encode("latin-1")
    obj(
        f"<<\n/Length {len(stream_bytes)}\n>>\nstream\n".encode("latin-1")
        + stream_bytes
        + b"\nendstream"
    )
    img_header = (
        f"<<\n/Type /XObject\n/Subtype /Image\n"
        f"/Width {w}\n/Height {h}\n"
        f"/ColorSpace /DeviceGray\n/BitsPerComponent 8\n"
        f"/Filter /FlateDecode\n"
        f"/Length {len(compressed)}\n>>\nstream\n"
    )
    obj(img_header.encode("latin-1") + compressed + b"\nendstream")

    out = b"%PDF-1.4\n"
    offsets = []
    for i, o in enumerate(objects, 1):
        offsets.append(len(out))
        if isinstance(o, bytes):
            out += f"{i} 0 obj\n".encode("latin-1") + o + b"\nendobj\n"
        else:
            out += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")

    xref_offset = len(out)
    out += f"xref\n0 {len(objects)+1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<<\n/Size {len(objects)+1}\n/Root 1 0 R\n>>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode("latin-1")

    with open(path, "wb") as f:
        f.write(out)

    print(f"Saved: {path}  ({len(out)/1024:.0f} KB)")
    print(f"  {SQUARES_X}x{SQUARES_Y} squares, square={SQUARE_MM}mm, marker={MARKER_MM}mm")
    print(f"  Resolution: {w}x{h} px ({dpi} DPI)")
    print(f"  Print at 100% scale on A4 (no fit-to-page)")


def main():
    parser = argparse.ArgumentParser(description="Generate ChArUco calibration board PDF (A4)")
    parser.add_argument("--output", "-o", default="charuco_board.pdf", help="Output PDF path")
    parser.add_argument("--dpi", type=int, default=150, help="Resolution in DPI (default: 150)")
    args = parser.parse_args()

    print(f"Generating ChArUco board ({SQUARES_X}x{SQUARES_Y}, AprilTag 36h11) for A4...")
    img, pw, ph = generate_board_image(args.dpi)
    save_pdf(img, args.output, args.dpi, pw, ph)
    print("Done. Print this board and use it for camera calibration.")


if __name__ == "__main__":
    main()
