#!/usr/bin/env /opt/homebrew/bin/python3
"""
简历 PDF 解析脚本
用法: python3 parse_resume.py [pdf_path]
如果不指定路径，自动读取 {{OPENCLAW_HOME}}/media/inbound/ 中最新的 PDF
"""
import sys
import os
import glob
import json
from datetime import datetime

try:
    import PyPDF2
except ImportError:
    print("ERROR: PyPDF2 not installed. Run: /opt/homebrew/bin/pip3 install --break-system-packages PyPDF2")
    sys.exit(1)

INBOUND_DIR = os.path.expanduser("{{OPENCLAW_HOME}}/media/inbound")
RESUME_MASTER = os.path.expanduser("{{OPENCLAW_HOME}}/workspace/career/resume_master.md")

def find_latest_pdf(directory):
    """找到最新的 PDF 文件"""
    pdfs = glob.glob(os.path.join(directory, "*.pdf"))
    if not pdfs:
        print(f"ERROR: No PDF files found in {directory}")
        sys.exit(1)
    latest = max(pdfs, key=os.path.getmtime)
    return latest

def extract_text(pdf_path):
    """从 PDF 提取文本"""
    reader = PyPDF2.PdfReader(pdf_path)
    text = ""
    for page in reader.pages:
        page_text = page.extract_text()
        if page_text:
            text += page_text + "\n"
    return text

def main():
    # 确定 PDF 路径
    if len(sys.argv) > 1:
        pdf_path = sys.argv[1]
    else:
        pdf_path = find_latest_pdf(INBOUND_DIR)
    
    if not os.path.exists(pdf_path):
        print(f"ERROR: File not found: {pdf_path}")
        sys.exit(1)
    
    print(f"📄 解析文件: {os.path.basename(pdf_path)}")
    print(f"📁 文件大小: {os.path.getsize(pdf_path) / 1024:.1f} KB")
    print(f"⏰ 解析时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    
    # 提取文本
    text = extract_text(pdf_path)
    
    if not text.strip():
        print("ERROR: No text extracted from PDF. The file might be image-based.")
        sys.exit(1)
    
    # 输出提取的文本
    print(text)
    print("=" * 60)
    print(f"✅ 提取成功！共 {len(text)} 个字符")
    print(f"💡 请将以上内容结构化后写入: {RESUME_MASTER}")

if __name__ == "__main__":
    main()
