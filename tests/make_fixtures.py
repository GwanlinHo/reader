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


# 目錄型中文 txt：開頭一份目錄，之後才是正文（實際電子書常見）
chs = [("一", "初到"), ("二", "風波"), ("三", "轉機"), ("四", "結局")]
lines = ["紅樓一夢", "", "目錄", ""]
lines += ["第%s章\u3000%s" % (n, t2) for n, t2 in chs]
lines += [""]
for n, t2 in chs:
    lines.append("第%s章\u3000%s" % (n, t2))
    lines.append("")
    lines.append("這是第%s章的正文。" % n + "內容補字。" * 30)
    lines.append("")
write("toc_style.txt", "\n".join(lines).encode("utf-8"))


# 正文直接掛在 div 底下、用 <br> 分段的 epub（實際書店檔案常見；只有章名包在 h3）
BR_CH1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c1</title></head><body>
<div> <h3>第一章</h3><br /><br /> 天色已晚，主人鎖了大門。<br /><br /> 第二段正文在這裡。<br /><br /> 第三段正文也要抓到。</div>
</body></html>"""

BR_TOC = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>toc</title></head><body>
<div> 第一章<br />第二章</div>
</body></html>"""

BR_OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>散落文字測試</dc:title><dc:creator>測試作者</dc:creator>
    <dc:language>zh-TW</dc:language><dc:identifier id="bid">urn:uuid:br-1</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="t" href="toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="t"/><itemref idref="c1"/></spine>
</package>"""

BR_NCX = """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1"><navLabel><text>目錄</text></navLabel><content src="toc.xhtml"/></navPoint>
  <navPoint id="n2"><navLabel><text>第一章</text></navLabel><content src="1.xhtml"/></navPoint>
</navMap></ncx>"""

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml",
               CONTAINER.replace("OEBPS/content.opf", "OEBPS/content.opf"), compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/content.opf", BR_OPF, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/toc.ncx", BR_NCX, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/toc.xhtml", BR_TOC, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/1.xhtml", BR_CH1, compress_type=zipfile.ZIP_DEFLATED)
write("brdiv.epub", buf.getvalue())


# 多層目錄（篇 > 章 > 節）的 epub：篇名頁只有一行標題，會被併進下一段渲染單位，
# 但目錄裡必須還看得到篇名與章名；小節是同一檔案內的錨點。
def tree_page(title, secs):
    body = "<h1>%s</h1>\n" % title
    for sid, st in secs:
        body += '<h2 id="%s">%s</h2>\n' % (sid, st)
        body += "<p>%s的內容。%s</p>\n" % (st, "這一段是填充文字，讓小節有足夠的份量。" * 6)
    return ('<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">'
            '<head><title>%s</title></head><body>\n%s</body></html>' % (title, body))

TREE = [
    ("p1.xhtml", "第一篇　單句", None),
    ("c1.xhtml", "第一章　基本句型", [("s1", "前言"), ("s2", "主部與述部"), ("s3", "補語")]),
    ("c2.xhtml", "第二章　名詞片語", [("s1", "名詞片語的構造"), ("s2", "限定詞")]),
    ("p2.xhtml", "第二篇　複句", None),
    ("c3.xhtml", "第三章　合句", [("s1", "對等連接詞"), ("s2", "相關字組")]),
]

def build_tree_epub(path, use_ncx=False):
    nav = ['<nav epub:type="toc"><ol>']
    ncx = []
    order = [0]
    def np(label, src, kids=""):
        order[0] += 1
        return ('<navPoint id="n%d" playOrder="%d"><navLabel><text>%s</text></navLabel>'
                '<content src="%s"/>%s</navPoint>' % (order[0], order[0], label, src, kids))
    i = 0
    while i < len(TREE):
        fn, title, _ = TREE[i]
        nav.append('<li><a href="text/%s">%s</a><ol>' % (fn, title))
        kids = ""
        i += 1
        while i < len(TREE) and TREE[i][2] is not None:
            cfn, ct, secs = TREE[i]
            nav.append('<li><a href="text/%s">%s</a><ol>' % (cfn, ct))
            sub = "".join(np(st, "text/%s#%s" % (cfn, sid)) for sid, st in secs)
            nav.extend('<li><a href="text/%s#%s">%s</a></li>' % (cfn, sid, st) for sid, st in secs)
            nav.append("</ol></li>")
            kids += np(ct, "text/" + cfn, sub)
            i += 1
        nav.append("</ol></li>")
        ncx.append(np(title, "text/" + fn, kids))
    nav.append("</ol></nav>")
    items = "".join('<item id="i%d" href="text/%s" media-type="application/xhtml+xml"/>' % (k, t[0])
                    for k, t in enumerate(TREE))
    spine = "".join('<itemref idref="i%d"/>' % k for k in range(len(TREE)))
    if use_ncx:
        tocitem = '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        spine_open = '<spine toc="ncx">'
    else:
        tocitem = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        spine_open = "<spine>"
    opf = ('<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
           'unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           '<dc:title>多層目錄測試</dc:title><dc:creator>測試作者</dc:creator><dc:language>zh-TW</dc:language>'
           '<dc:identifier id="bid">urn:uuid:tree-%d</dc:identifier></metadata><manifest>%s%s</manifest>%s%s</spine></package>'
           % (1 if use_ncx else 0, tocitem, items, spine_open, spine))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        if use_ncx:
            z.writestr("OEBPS/toc.ncx", '<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" '
                       'version="2005-1"><navMap>%s</navMap></ncx>' % "".join(ncx), compress_type=zipfile.ZIP_DEFLATED)
        else:
            z.writestr("OEBPS/nav.xhtml", '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" '
                       'xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目錄</title></head><body>%s</body></html>'
                       % "\n".join(nav), compress_type=zipfile.ZIP_DEFLATED)
        for fn, title, secs in TREE:
            z.writestr("OEBPS/text/" + fn, tree_page(title, secs or []), compress_type=zipfile.ZIP_DEFLATED)
    write(path, buf.getvalue())

build_tree_epub("tree.epub")
build_tree_epub("tree_ncx.epub", use_ncx=True)
