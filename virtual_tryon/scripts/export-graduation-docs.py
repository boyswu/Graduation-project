"""Rebuild graduation Word documents, figures and trace summary from project evidence.

Run with a Python environment containing python-docx and Pillow. No GPU required.
Only final deliverables are written to public/graduation; bytecode is not needed.
"""
from pathlib import Path
import json
import math
import re
import shutil
import statistics
import sys

from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.shared import Cm, Pt, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "graduation"
FONT = Path("C:/Windows/Fonts/msyh.ttc")
if not FONT.exists():
    FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")


def font(size):
    return ImageFont.truetype(str(FONT), size)


def figure_architecture():
    image = Image.new("RGB", (1500, 800), "#f7f7f0")
    d = ImageDraw.Draw(image)
    d.text((65, 42), "交互式虚拟试衣系统架构", font=font(37), fill="#203c35")
    d.text((65, 100), "完整画面生成路径  /  默认实现", font=font(22), fill="#627366")
    nodes = [
        (65, "浏览器工作台", ["服装选择与任意图片上传", "getUserMedia 摄像头", "Worker + OffscreenCanvas"]),
        (560, "有界双向传输", ["二进制 WebSocket", "本机 8022 → 远端 8030", "最多3个在途上传 + 最新等待帧"]),
        (1055, "远程 GPU 服务", ["FastAPI + PyTorch / CUDA", "FLUX.2 Klein 4B + FluxRT", "两步推理 / 参考条件缓存"]),
    ]
    for x, title, lines in nodes:
        d.rounded_rectangle((x, 180, x + 380, 445), radius=15, fill="#203c35")
        d.text((x + 22, 207), title, font=font(28), fill="#f7f7f0")
        for i, line in enumerate(lines):
            d.text((x + 22, 275 + i * 44), line, font=font(18), fill="#dae4d5")
    for x in (458, 953):
        d.text((x, 285), "→", font=font(42), fill="#708a68")
    d.rounded_rectangle((65, 505, 1435, 655), radius=15, fill="#e3e7dd")
    d.text((93, 530), "完整输出 → 图像解码 → Canvas 显示 → 可选 RIFE 补帧", font=font(27), fill="#203c35")
    d.text((93, 584), "同一帧编号贯穿采集、确认、推理、回传和绘制；原始生成帧与插值帧分别统计", font=font(22), fill="#52674d")
    d.text((65, 704), "独立主页与免 GPU 演示不进行推理；数字日志不记录摄像头或服装图片。", font=font(22), fill="#627366")
    image.save(OUT / "系统架构.png")


def walk_events(value):
    if isinstance(value, dict):
        if value.get("event") == "client_display":
            yield value
        for child in value.values():
            yield from walk_events(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_events(child)


def trace_summary():
    source = ROOT / "docs" / "architecture-reassessment-20261026.json"
    data = json.loads(source.read_text(encoding="utf-8"))
    trace = "d5e1b52a-1004-4b2d-8e21-b292d78974c3"
    rows = {row["frame_id"]: row for row in walk_events(data) if row["trace_id"] == trace}
    rows = sorted(rows.values(), key=lambda row: row["metrics"]["client_at_ms"])
    values = sorted(row["metrics"]["total_ms"] for row in rows)
    median = lambda key: statistics.median(row["metrics"][key] for row in rows)
    elapsed = (rows[-1]["metrics"]["client_at_ms"] - rows[0]["metrics"]["client_at_ms"]) / 1000
    residual = [row["metrics"]["total_ms"] - row["metrics"]["service_ms"] - row["metrics"].get("capture_encode_ms", 0) - row["metrics"].get("queue_ms", 0) - row["metrics"].get("display_buffer_ms", 0) for row in rows]
    if not math.isclose(statistics.median(residual), data["paired_residual_transport_dispatch_p50_ms"], abs_tol=.01):
        raise ValueError("Recomputed paired residual differs from the archived audit; verify stage boundaries")
    result = {
        "measurement_date": "2026-10-26", "evidence_type": "historical_human_camera",
        "source": "docs/architecture-reassessment-20261026.json", "trace_id": trace,
        "count": len(rows), "output_size": [320, 320], "smoothing": False,
        "p50_ms": statistics.median(values),
        "p95_ms": values[min(len(values) - 1, math.ceil(len(values) * .95) - 1)],
        "max_ms": max(values), "inference_p50_ms": median("inference_ms"),
        "service_p50_ms": median("service_ms"), "capture_p50_ms": median("capture_encode_ms"),
        "paired_residual_p50_ms": statistics.median(residual),
        "observed_original_display_fps": (len(rows) - 1) / elapsed,
        "limitation": "Historical results, not a new GPU benchmark. Residual includes transport, buffering and dispatch. Stage medians cannot be added.",
        "raw_frames": [{"frame_id": r["frame_id"], "client_at_ms": r["metrics"]["client_at_ms"], **{k: r["metrics"][k] for k in ("total_ms", "inference_ms", "service_ms", "capture_encode_ms", "queue_ms", "display_buffer_ms")}} for r in rows],
    }
    (OUT / "实验数据摘要.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    image = Image.new("RGB", (1500, 790), "#f7f7f0")
    d = ImageDraw.Draw(image)
    d.text((65, 40), "历史真人测试延迟指标", font=font(37), fill="#203c35")
    d.text((65, 103), "2026-10-26  /  320×320  /  低延迟原帧  /  30 个输出样本", font=font(22), fill="#627366")
    items = [("采样到绘制 P50", result["p50_ms"], "#203c35"), ("采样到绘制 P95", result["p95_ms"], "#526f4e"), ("模型推理 P50", result["inference_p50_ms"], "#8b78a5"), ("逐帧剩余项 P50", result["paired_residual_p50_ms"], "#9ca580")]
    for i, (label, value, color) in enumerate(items):
        y = 200 + 112 * i
        d.text((65, y + 5), label, font=font(24), fill="#203c35")
        d.rounded_rectangle((365, y, 365 + int(value), y + 45), radius=4, fill=color)
        d.text((385 + int(value), y + 5), f"{value:.1f} ms", font=font(24), fill="#203c35")
    d.text((65, 675), "不同统计口径，不能相加；剩余项包含传输、缓冲与调度，不是纯网络 RTT。", font=font(22), fill="#627366")
    d.text((65, 722), "本轮远程 GPU 不可用，尚未测得界面优化后的真人端到端结果。", font=font(22), fill="#627366")
    image.save(OUT / "历史延迟指标.png")
    return result


def set_font(style, name, size):
    style.font.name = "Times New Roman"
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor(0, 0, 0)
    rf = style.element.get_or_add_rPr().get_or_add_rFonts()
    rf.set(qn("w:eastAsia"), name)
    rf.set(qn("w:ascii"), "Times New Roman")
    rf.set(qn("w:hAnsi"), "Times New Roman")


def add_field(paragraph, instruction):
    run = paragraph.add_run()
    start = OxmlElement("w:fldChar"); start.set(qn("w:fldCharType"), "begin")
    text = OxmlElement("w:instrText"); text.set(qn("xml:space"), "preserve"); text.text = instruction
    end = OxmlElement("w:fldChar"); end.set(qn("w:fldCharType"), "end")
    run._r.extend((start, text, end))


def build_doc(source):
    text = source.read_text(encoding="utf-8")
    lines = text.splitlines()
    document = Document()
    section = document.sections[0]
    section.page_width = Cm(21); section.page_height = Cm(29.7)
    section.top_margin = section.bottom_margin = Cm(2.4)
    section.left_margin = Cm(2.8); section.right_margin = Cm(2.4)
    section.header_distance = section.footer_distance = Cm(1.15)
    section.different_first_page_header_footer = True
    for name, size in [("Normal", 11), ("Title", 22), ("Heading 1", 16), ("Heading 2", 13), ("Caption", 10), ("TOC 1", 11)]:
        if name not in document.styles:
            from docx.enum.style import WD_STYLE_TYPE
            document.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
        set_font(document.styles[name], "SimSun" if name in ("Normal", "Caption") else "Microsoft YaHei", size)
    normal = document.styles["Normal"].paragraph_format
    normal.line_spacing = 1.3; normal.space_after = Pt(5)
    if source.stem == "毕设配套材料":
        normal.line_spacing = 1.23; normal.space_after = Pt(4)
    normal.first_line_indent = Cm(.74)
    for name in ("Heading 1", "Heading 2"):
        document.styles[name].paragraph_format.space_before = Pt(16)
        document.styles[name].paragraph_format.space_after = Pt(9)
        document.styles[name].paragraph_format.keep_with_next = True
        document.styles[name].paragraph_format.first_line_indent = Cm(0)
    document.styles["Caption"].paragraph_format.first_line_indent = Cm(0)
    document.styles["Caption"].paragraph_format.space_after = Pt(11)
    document.core_properties.title = lines[0][2:]
    document.core_properties.author = ""
    document.core_properties.last_modified_by = ""
    header = section.header.paragraphs[0]
    header.text = "交互式虚拟试衣系统设计与实现"
    header.alignment = WD_ALIGN_PARAGRAPH.CENTER
    header.paragraph_format.first_line_indent = Cm(0)
    for r in header.runs: r.font.size = Pt(9)
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer.paragraph_format.first_line_indent = Cm(0)
    add_field(footer, " PAGE ")
    # The stock Word Title style contains a decorative bottom rule.
    for node in list(document.styles["Title"].element.iter(qn("w:pBdr"))):
        node.getparent().remove(node)
    cover_title = lines[0][2:]
    if source.stem == "毕业论文初稿":
        cover_title = "基于深度学习的\n交互式虚拟试衣系统设计与实现"
    title = document.add_paragraph(cover_title, "Title")
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_before = Pt(100)
    title.paragraph_format.space_after = Pt(35)
    title.paragraph_format.first_line_indent = Cm(0)
    first_section = next(i for i, l in enumerate(lines) if l.startswith("## "))
    for line in lines[1:first_section]:
        if line.strip():
            p = document.add_paragraph(line)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.first_line_indent = Cm(0)
            p.paragraph_format.space_after = Pt(14)
    document.add_page_break()
    toc = document.add_paragraph("目录", "Title")
    toc.paragraph_format.first_line_indent = Cm(0)
    toc_body = document.add_paragraph()
    toc_body.paragraph_format.first_line_indent = Cm(0)
    add_field(toc_body, ' TOC \\o "1-1" \\h \\z ')
    update = OxmlElement("w:updateFields"); update.set(qn("w:val"), "true")
    document.settings.element.append(update)
    document.add_page_break()
    i = first_section
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1; continue
        if line.startswith("## "):
            # Start abstracts, chapters and appendices on a fresh page in the thesis.
            if source.stem == "毕业论文初稿" and i != first_section:
                document.add_page_break()
            document.add_heading(line[3:], level=1)
        elif line.startswith("### "):
            document.add_heading(line[4:], level=2)
        elif line.startswith("!["):
            match = re.match(r"!\[(.+?)\]\((.+?)\)", line)
            if match:
                caption, name = match.groups()
                image_path = OUT / name
                with Image.open(image_path) as image:
                    width, height = image.size
                p = document.add_paragraph(); p.paragraph_format.first_line_indent = Cm(0)
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                p.paragraph_format.keep_with_next = True
                p.add_run().add_picture(str(image_path), width=Inches(min(6.0, 5.1 * width / height)))
                cp = document.add_paragraph(caption, "Caption"); cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [s.strip() for s in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r"[-: ]+", cell) for cell in cells): rows.append(cells)
                i += 1
            table = document.add_table(rows=1, cols=len(rows[0])); table.style = "Table Grid"
            table.autofit = True
            for index, row in enumerate(rows):
                cells = table.rows[0].cells if index == 0 else table.add_row().cells
                for cell, content in zip(cells, row):
                    cell.text = content
                    for p in cell.paragraphs:
                        p.paragraph_format.first_line_indent = Cm(0)
                        p.paragraph_format.line_spacing = 1.15
                        p.paragraph_format.space_before = p.paragraph_format.space_after = Pt(5)
                        for run in p.runs: run.font.size = Pt(9); run.bold = index == 0
                    if index == 0:
                        shade = OxmlElement("w:shd"); shade.set(qn("w:fill"), "EDF1EB"); cell._tc.get_or_add_tcPr().append(shade)
                cant = OxmlElement("w:cantSplit"); table.rows[index]._tr.get_or_add_trPr().append(cant)
            repeat = OxmlElement("w:tblHeader"); table.rows[0]._tr.get_or_add_trPr().append(repeat)
            document.add_paragraph().paragraph_format.space_after = Pt(2)
            continue
        elif line.startswith("```"):
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                p = document.add_paragraph(lines[i]); p.paragraph_format.first_line_indent = Cm(0)
                p.paragraph_format.line_spacing = 1.1
                for r in p.runs: r.font.name = "Consolas"; r.font.size = Pt(9)
                i += 1
        else:
            p = document.add_paragraph(line)
            p.paragraph_format.widow_control = True
            if re.match(r"^\[\d+\]", line):
                p.paragraph_format.first_line_indent = Cm(0)
                p.paragraph_format.line_spacing = 1.15
                for r in p.runs: r.font.size = Pt(9)
        i += 1
    target = source.with_suffix(".docx")
    document.save(target)
    return target


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    figure_architecture()
    result = trace_summary()
    # Preserve each existing input/output pair; arrange six rows as a readable
    # two-column figure rather than squeezing a very tall image into the thesis.
    with Image.open(ROOT / "docs" / "fixed-garment-comparison-20261026.jpg") as original:
        width, height = original.size
        row_h = height // 6
        grid = Image.new("RGB", (width * 2, row_h * 3), "white")
        for index in range(6):
            pair = original.crop((0, index * row_h, width, (index + 1) * row_h))
            grid.paste(pair, ((index % 2) * width, (index // 2) * row_h))
        grid.save(OUT / "固定样衣对照.jpg", quality=94)
    for name in ("毕业论文初稿", "毕设配套材料"):
        print(build_doc(OUT / f"{name}.md").name)
    print(json.dumps({k: result[k] for k in ("count", "p50_ms", "p95_ms", "observed_original_display_fps")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
