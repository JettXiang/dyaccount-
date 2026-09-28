# -*- coding: utf-8 -*-
"""
C 计划 · 搜索词数据反推脚本（可复跑）

作用：从历史导出 CSV 的作者语料里，反推「高产题材词」，输出候选词清单，
      用于扩充 content.js 里的 SEARCH_TOPIC。

用法：
    python mine_words.py                       # 自动扫描桌面上的 douyin-ai-*.csv
    python mine_words.py a.csv b.csv           # 指定 CSV
    python mine_words.py --dir "D:\\data"      # 指定扫描目录
    python mine_words.py --min 5               # 降低命中门槛（默认 8 位作者）

产出：
    候选词清单_YYYYMMDD.csv   （词, 命中作者数, 是否已在词库, 建议）
    控制台同时打印：现有词库每个词的命中数（用于发现死词）
"""
import sys

sys.dont_write_bytecode = True  # 防止生成 __pycache__（Chrome 扩展会因下划线目录加载失败）

import argparse
import collections
import csv
import datetime
import glob
import os
import re

def _find_content_js():
    """自动定位扩展里的 content.js（优先脚本同目录 content\，其次上一级）。"""
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "content", "content.js"),
                 os.path.join(here, "..", "content", "content.js")):
        cand = os.path.normpath(cand)
        if os.path.isfile(cand):
            return cand
    return os.path.normpath(os.path.join(here, "content", "content.js"))


def _find_default_dir():
    """返回桌面目录，用于默认扫描 CSV；Windows 下用系统 API 取（兼容 OneDrive 桌面重定向）。"""
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes
            buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
            ctypes.windll.shell32.SHGetFolderPathW(None, 0x0010, None, 0, buf)  # CSIDL_DESKTOPDIRECTORY
            if buf.value and os.path.isdir(buf.value):
                return buf.value
        except Exception:
            pass
    home = os.path.expanduser("~")
    for name in ("Desktop", "桌面"):
        d = os.path.join(home, name)
        if os.path.isdir(d):
            return d
    return home


CONTENT_JS = _find_content_js()
DEFAULT_DIR = _find_default_dir()

STOP = set("""
的 了 是 我 你 他 她 们 与 和 之 中 大 小 新 老 全 集 部 第 季 上 下 前 后 一 二 三 四 五 六 七 八 九 十 百 千 万 亿 个 只 条 位 名 版 号
短剧 漫剧 动漫 动画 漫画 剧场 剧集 番剧 视频 作品 原创 官方 账号 频道 主页 关注 点赞 分享 评论 直播 更新 连载 合集 系列
AI AIGC ai aigc 抖音 快手 小红书 微博 b站 B站 哔哩哔哩 微信 公众号
故事 小说 内容 创作 制作 团队 工作室 传媒 文化 影业 影视 网络 科技 有限 公司 出品
""".split())

# 通用噪声：序数/代词/平台名/游戏名/体裁词，不是「题材」
EXTRA_NOISE = """
第一 第二 第三 第一季 第二季 我的 我在 我是 我们 一个 那些 这些 不是 成为 正在 来了 看完 一口气看
持续 持续更 续更 后续 全集 正片 二次 二创 原创 日常 日记 生活 记录 知识 人文 探索 体验 观察 挑战
计划 行动 指南 现代 真人 电影 音乐 游戏 汽车 搞笑 情感 剧情 编导 导演 小小 一只 一口 一家 三大
十二 中国 大学 校园 学院 世界 时光 拾光 晚风 未来 时空 载中 新中 成了 那些事 的故事 的日常 的小
的日 的合 的故 的奇 的世界 漫剪 漫社 漫馆 说漫 漫漫 幼儿 动物园 铠甲 哈基 噜噜 嘎嘎 鼠鼠 猫猫
小白 反骨 大王 先生 观察 红果 番茄 短 漫 剧 社
三角洲 无畏契约 契约 峡谷 王者 李云龙 打工人 编导 正片 番外 花絮 预告 混剪
""".split()
STOP |= set(EXTRA_NOISE)


def read_js_list(src, name):
    """从 content.js 里读出一个字符串数组常量，例如 SEARCH_TOPIC / TYPE_WHITELIST"""
    m = re.search(name + r"\s*=\s*\[(.*?)\]", src, re.S)
    if not m:
        return []
    return re.findall(r'"([^"]+)"', m.group(1))


def load_js_consts():
    try:
        with open(CONTENT_JS, "r", encoding="utf-8") as f:
            src = f.read()
    except OSError:
        print("[warn] 读不到 content.js，词库对比跳过:", CONTENT_JS)
        return [], [], [], 2
    topic = read_js_list(src, "SEARCH_TOPIC")
    cat = read_js_list(src, "SEARCH_CATEGORY")
    tools = read_js_list(src, "SEARCH_TOOLS")
    wl = read_js_list(src, "TYPE_WHITELIST")
    bl = read_js_list(src, "TYPE_BLACKLIST")
    m = re.search(r"VALID_MIN_VIDEO\s*=\s*(\d+)", src)
    vmin = int(m.group(1)) if m else 2
    return topic, cat + tools, wl, bl, vmin


def norm(s):
    return re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", s or "")


def pick(row, *names):
    """兼容中英文表头（旧版导出英文、v1.1.2+ 导出中文）"""
    for n in names:
        if n in row and row[n] not in (None, ""):
            return row[n]
    return ""


def normalize_row(row):
    return {
        "nickname": pick(row, "nickname", "昵称"),
        "sec_uid": pick(row, "sec_uid", "secUid", "sec_id"),
        "mix_name": pick(row, "mix_name", "mixName", "合集名"),
        "video_count": pick(row, "video_count", "videoCount", "视频数"),
        "search_word": pick(row, "search_word", "搜索词"),
    }


def load_authors(paths):
    rows = {}
    for p in paths:
        try:
            with open(p, "r", encoding="utf-8-sig", newline="") as f:
                for r in csv.DictReader(f):
                    r = normalize_row(r)
                    k = (r.get("sec_uid") or "").strip()
                    if k and k not in rows:
                        rows[k] = r
        except OSError as e:
            print("[warn] 跳过", p, e)
    return rows


def pick_csvs(args):
    if args.files:
        return args.files
    d = args.dir or DEFAULT_DIR
    found = sorted(glob.glob(os.path.join(d, "douyin-ai-*.csv")))
    found += sorted(glob.glob(os.path.join(d, "*mix-authors*.csv")))
    return found


def is_target(row, wl, bl, vmin):
    """与 content.js 的 isTargetType + 视频数阈值 同口径"""
    text = (norm(row.get("mix_name")) + norm(row.get("nickname"))).upper()
    if not text:
        return False
    if any(norm(k).upper() in text for k in bl):
        return False
    if not any(norm(k).upper() in text for k in wl):
        return False
    try:
        vc = int(row.get("video_count") or 0)
    except ValueError:
        vc = 0
    return vc >= vmin


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", help="历史导出 CSV 路径")
    ap.add_argument("--dir", help="自动扫描目录")
    ap.add_argument("--min", type=int, default=8, help="候选词最低命中作者数（默认 8）")
    ap.add_argument("--top", type=int, default=150, help="输出候选词条数（默认 150）")
    ap.add_argument("--raw", action="store_true", help="不清洗语料，直接用全量作者（噪声多）")
    args = ap.parse_args()

    paths = pick_csvs(args)
    if not paths:
        print("没有找到 CSV。用 python mine_words.py <csv路径> 指定。")
        sys.exit(1)
    print("输入文件:")
    for p in paths:
        print("  -", p)

    rows = load_authors(paths)
    print("语料作者数(并集):", len(rows))
    if not rows:
        sys.exit(1)

    topic, prefix_words, wl, bl, vmin = load_js_consts()
    print("content.js 现有题材词:", len(topic), "个 | 品类/工具词:", len(prefix_words), "个")

    if not args.raw and wl:
        clean = {k: r for k, r in rows.items() if is_target(r, wl, bl, vmin)}
        print("规则清洗后作者数: %d（白名单命中 且 不撞黑名单 且 视频数≥%d）" % (len(clean), vmin))
        rows = clean
        if not rows:
            print("清洗后为空，加 --raw 用全量语料再试。")
            sys.exit(1)
    elif args.raw:
        print("已跳过规则清洗（--raw）")

    texts = [norm(r.get("mix_name")) + "|" + norm(r.get("nickname")) for r in rows.values()]
    print("\n=== 现有 SEARCH_TOPIC 命中作者数（0 = 死词，考虑删） ===")
    dead = []
    hits = []
    for w in topic:
        c = sum(1 for t in texts if w in t)
        hits.append((c, w))
        if c == 0:
            dead.append(w)
    for c, w in sorted(hits):
        print("  %5d  %s" % (c, w))
    if dead:
        print("  死词:", "、".join(dead))

    # 2) n-gram 挖掘
    cnt = collections.Counter()
    for t in texts:
        for seg in t.split("|"):
            L = len(seg)
            for n in (2, 3, 4):
                for i in range(L - n + 1):
                    g = seg[i:i + n]
                    if re.fullmatch(r"[\u4e00-\u9fa5]+", g):
                        cnt[g] += 1

    already = set(topic)
    long_stop = [s for s in STOP if len(s) >= 3]
    cand = []
    for g, c in cnt.items():
        if c < args.min:
            continue
        if g in STOP or g in already:
            continue
        if any(g in w or w in g for w in (wl + bl)):
            continue
        if any(s in g for s in STOP if len(s) >= 2):
            continue
        if any(g in s for s in long_stop):      # 已知噪声词（如「三角洲」）的碎片
            continue
        cand.append((c, g))

    # 碎片判定 1：被「更长、且支持度相近」的词包含（在全量 n-gram 里找父词）
    by_len = collections.defaultdict(list)
    for k in cnt:
        if len(k) <= 6:
            by_len[len(k)].append(k)
    cand.sort(key=lambda x: (-x[0], -len(x[1])))
    stage = []
    for c, g in cand:
        covered = False
        for L in (len(g) + 1, len(g) + 2, len(g) + 3):
            for k in by_len.get(L, ()):
                if g in k and cnt[k] >= c * 0.75:
                    covered = True
                    break
            if covered:
                break
        if covered:
            continue
        stage.append((c, g))

    # 碎片判定 2：位置级——某个出现位置上若存在更长的高频词（共享起点或终点），
    # 且这种「可延长」的出现占多数，就说明它只是长词的碎片（如 呆动 ← 呆动漫/呆呆动画）
    segs = [s for t in texts for s in t.split("|") if s]
    picked = []
    for c, g in stage:
        L = len(g)
        total = ext = 0
        for s in segs:
            i = s.find(g)
            while i != -1:
                total += 1
                ok = False
                for n in (L + 1, L + 2, L + 3):
                    if i + n <= len(s) and cnt.get(s[i:i + n], 0) >= 2:
                        ok = True
                        break
                    j = i - (n - L)
                    if j >= 0 and cnt.get(s[j:i + L], 0) >= 2:
                        ok = True
                        break
                if ok:
                    ext += 1
                i = s.find(g, i + 1)
        if total and ext >= total * 0.6:
            continue
        if any(g in p[1] for p in picked):
            continue
        picked.append((c, g))

    out = "候选词清单_%s.csv" % datetime.date.today().strftime("%Y%m%d")
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["词", "命中作者数", "是否已在词库", "建议"])
        for c, g in picked[:args.top]:
            w.writerow([g, c, "否", "加进 SEARCH_TOPIC" if c >= args.min * 2 else "备选"])

    print("\n=== 新候选词 TOP %d（作者数 / 词） ===" % min(args.top, len(picked)))
    for c, g in picked[:args.top]:
        print("%5d  %s" % (c, g))
    print("\n已写出:", os.path.abspath(out))
    print("下一步：挑高频词贴进 content.js 的 SEARCH_TOPIC，重新加载扩展即可生效。")


if __name__ == "__main__":
    main()