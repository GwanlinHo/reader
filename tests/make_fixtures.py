# -*- coding: utf-8 -*-
"""產生測試用的 txt / epub 檔案。"""
import io, os, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
os.makedirs(FIX, exist_ok=True)

TXT = """第一章　起頭

這是第一段，測試斷句。他說：「這個 PWA 很好用。」然後就走了。

這一段混了英文：The quick brown fox jumps over the lazy dog. 接著回到中文。

第二章　數字與標點

價格是 3.14 元，時間 12:30 開始，版本 v1.2.3 發佈。
沒有句末標點的一行
"""

def write(name, data):
    p = os.path.join(FIX, name)
    with open(p, "wb") as f:
        f.write(data)
    print(name, len(data))

write("sample_utf8.txt", TXT.encode("utf-8"))
write("sample_utf8_bom.txt", b"\xef\xbb\xbf" + TXT.encode("utf-8"))
write("sample_big5.txt", TXT.encode("big5"))
write("sample_gb.txt", TXT.replace("這", "这").encode("gb18030"))

EN = """Chapter 1

Call me Ishmael. Some years ago, never mind how long precisely, I thought I would sail about a little.
Mr. Smith said hello. It was 3.5 miles away.
"""
write("sample_en.txt", EN.encode("utf-8"))

# ---------- epub ----------
CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>測試書名</dc:title>
    <dc:creator>測試作者</dc:creator>
    <dc:language>zh-TW</dc:language>
    <dc:identifier id="bid">urn:uuid:test-1234</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="skipme" href="text/skip.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="skipme" linear="no"/>
  </spine>
</package>"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目錄</title></head><body>
<nav epub:type="toc"><ol>
  <li><a href="text/ch1.xhtml">卷一　開端</a></li>
  <li><a href="text/ch2.xhtml">卷二　中英夾雜</a></li>
</ol></nav>
</body></html>"""

CH1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch1</title>
<style>p{margin:0}</style></head><body>
<h1>卷一　開端</h1>
<p>第一段文字。這裡有第二句。</p>
<div><p>巢狀段落也要抓到。</p><p>第二個巢狀段落。</p></div>
<blockquote>這是引文段落。</blockquote>
<p>詩句一<br/>詩句二</p>
<script>var x = 1;</script>
</body></html>"""

CH2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch2</title></head><body>
<h2>卷二　中英夾雜</h2>
<p>這個 PWA 真的很好用。</p>
<p>他說 The quick brown fox jumps over the lazy dog every single morning. 然後笑了。</p>
<ul><li>清單項目一</li><li>清單項目二</li></ul>
</body></html>"""

SKIP = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>skip</title></head><body>
<p>這一篇 linear=no，不應該出現在內容裡。</p></body></html>"""

def build_epub(path, seekable=True, ncx_only=False):
    opf = OPF
    extra = []
    if ncx_only:
        opf = OPF.replace('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
                          '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
        opf = opf.replace("<spine>", '<spine toc="ncx">')
        ncx = """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<navMap>
  <navPoint id="n1" playOrder="1"><navLabel><text>NCX 卷一</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
  <navPoint id="n2" playOrder="2"><navLabel><text>NCX 卷二</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
</navMap></ncx>"""
        extra.append(("OEBPS/toc.ncx", ncx))
    else:
        extra.append(("OEBPS/nav.xhtml", NAV))

    buf = io.BytesIO()
    target = buf if seekable else Unseekable(buf)
    with zipfile.ZipFile(target, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        for n, d in extra:
            z.writestr(n, d, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/text/ch1.xhtml", CH1, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/text/ch2.xhtml", CH2, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/text/skip.xhtml", SKIP, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/style.css", "p{line-height:1.6}", compress_type=zipfile.ZIP_DEFLATED)
    write(path, buf.getvalue())

class Unseekable:
    """只有 write 的檔案物件，逼 zipfile 使用資料描述子（bit 3），檔頭大小欄位會是 0。"""
    def __init__(self, inner):
        self.inner = inner
    def write(self, b):
        return self.inner.write(b)
    def flush(self):
        pass
    def tell(self):
        return self.inner.tell()

build_epub("sample.epub")
build_epub("sample_ncx.epub", ncx_only=True)
build_epub("sample_dd.epub", seekable=False)

# 長書：測試章節切段
long_txt = "\n\n".join("第 %d 段落。%s" % (i, "測試內容補字。" * 40) for i in range(1, 150))
write("long.txt", ("第一章　長章節\n\n" + long_txt).encode("utf-8"))
