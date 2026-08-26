#!/usr/bin/env python3
"""Generates the fake portal's downloadable PDFs (and two tiny PNG icons) from tree.json.

Pure stdlib: PDFs are written as raw PDF 1.4 objects with Helvetica text, one page each.
Run: python3 harness/fake-wsp/gen.py   (idempotent; output is committed to the repo)
"""

from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = HERE / "files"
ICONS = HERE / "public" / "icons"

CV_WEEKS = [
    "Week 01: Course overview, images as arrays, color spaces",
    "Week 02: Point operations, histograms, contrast and gamma",
    "Week 03: Linear filtering, convolution, Gaussian and box filters",
    "Week 04: Edge detection: Sobel, Canny, gradients",
    "Week 05: Image pyramids, scale space, resampling",
    "Week 06: Feature detection: Harris corners, blobs",
    "Week 07: Feature description and matching: SIFT, ORB",
    "Week 08: Midterm; geometric transforms, homographies",
    "Week 09: Image stitching, RANSAC",
    "Week 10: Camera model, calibration, stereo basics",
    "Week 11: Segmentation: thresholding, k-means, graph cuts",
    "Week 12: Optical flow and tracking",
    "Week 13: Convolutional networks for classification",
    "Week 14: Object detection: YOLO-style detectors",
    "Week 15: Project presentations and final review",
]

CV_LABS = [
    "Lab 01: Image basics with numpy",
    "Lab 02: Filtering and edges",
    "Lab 03: Features and matching",
    "Lab 04: Homography and stitching",
    "Lab 05: A small CNN classifier",
]

LAB1_TASKS = [
    "Task 1. Load an RGB image with imageio (or PIL) into a numpy array; print shape, dtype, min and max.",
    "Task 2. Convert the image to grayscale with the weights 0.299 R + 0.587 G + 0.114 B using numpy only.",
    "Task 3. Crop the central 50% of the image and flip it horizontally with array slicing (no loops).",
    "Task 4. Compute a 256-bin intensity histogram with numpy.bincount and plot it; comment on the contrast.",
    "Task 5. Threshold the grayscale image at its mean intensity and count foreground pixels; save the mask as PNG.",
    "Deliverable: a notebook lab01.ipynb with the five tasks, submitted on WSP before Friday 23:59 (week 2).",
]


def generic_weeks(course: str) -> list[str]:
    return [
        f"Week {i:02d}: {course.split(' ', 1)[1]} - topic {i}" for i in range(1, 16)
    ]


def pdf_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(lines: list[str]) -> bytes:
    """One A4 page, Helvetica; the first line is the title (16pt), the rest 11pt."""
    content = [
        "BT",
        "/F1 16 Tf",
        "50 790 Td",
        f"({pdf_escape(lines[0])}) Tj",
        "/F1 11 Tf",
        "0 -28 Td",
    ]
    for line in lines[1:]:
        content.append(f"({pdf_escape(line)}) Tj")
        content.append("0 -16 Td")
    content.append("ET")
    stream = "\n".join(content).encode("latin-1", "replace")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length "
        + str(len(stream)).encode()
        + b" >>\nstream\n"
        + stream
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def lines_for(course: str, instructor: str, file_name: str) -> list[str]:
    stem = file_name.removesuffix(".pdf")
    head = [
        f"{course}",
        f"Instructor: {instructor}",
        "KBTU, School of Information Technology and Engineering",
        "",
    ]
    if stem == "syllabus":
        weeks = CV_WEEKS if course.startswith("CSCI3240") else generic_weeks(course)
        body = ["Syllabus - weekly schedule (15 weeks)", *weeks, ""]
        if course.startswith("CSCI3240"):
            body += [
                "Labs (Fridays, room 412):",
                *CV_LABS,
                "",
                "Grading: labs 30%, midterm 30%, final project 40%.",
            ]
        return head + body
    if stem == "Lab_01_Image_Basics":
        return (
            head
            + [
                "Lab 01 - Image basics (numpy)",
                "Goal: get comfortable treating images as numpy arrays.",
                "",
            ]
            + LAB1_TASKS
        )
    if stem.startswith("Lecture_"):
        num = stem.split("_")[1]
        title = stem.split("_", 2)[2].replace("_", " ")
        return head + [
            f"Lecture {num}: {title}",
            "",
            "Key points:",
            "- What the course is about and how it is graded.",
            "- Images as arrays: height x width x channels, dtype uint8.",
            "- Tooling: numpy, OpenCV, matplotlib.",
        ]
    return head + [
        stem.replace("_", " "),
        "",
        "Instructions are given in class; bring your laptop.",
    ]


def make_png(rgb: tuple[int, int, int], size: int = 16) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    tree = json.loads((HERE / "tree.json").read_text())
    count = 0
    for school in tree["schools"]:
        for instr in school["instructors"]:
            for course in instr["courses"]:
                folder = FILES / instr["name"] / course["name"]
                folder.mkdir(parents=True, exist_ok=True)
                for f in course["files"]:
                    (folder / f["name"]).write_bytes(
                        make_pdf(lines_for(course["name"], instr["name"], f["name"]))
                    )
                    count += 1
    ICONS.mkdir(parents=True, exist_ok=True)
    (ICONS / "gb.png").write_bytes(make_png((200, 30, 50)))
    (ICONS / "home.png").write_bytes(make_png((40, 90, 160)))
    (ICONS / "ru.png").write_bytes(make_png((255, 255, 255)))
    print(f"wrote {count} PDFs under {FILES} and 3 icons under {ICONS}")


if __name__ == "__main__":
    main()
