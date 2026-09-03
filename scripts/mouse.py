#!/usr/bin/env python3
"""模拟真实鼠标点击/双击（输入为 2x Retina 截图像素坐标）"""
import sys
import time
import Quartz

def ev(type_, x, y, clicks=1):
    e = Quartz.CGEventCreateMouseEvent(None, type_, (x, y), Quartz.kCGMouseButtonLeft)
    try:
        from Quartz import CGEventSetIntegerFieldValue as _set
        _set(e, Quartz.kCGMouseEventClickState, clicks)
    except Exception:
        pass
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)

def click(x_pt, y_pt):
    ev(Quartz.kCGEventMouseMoved, x_pt, y_pt)
    time.sleep(0.12)
    ev(Quartz.kCGEventLeftMouseDown, x_pt, y_pt, 1)
    time.sleep(0.12)
    ev(Quartz.kCGEventLeftMouseUp, x_pt, y_pt, 1)

def double(x_pt, y_pt):
    click(x_pt, y_pt)
    time.sleep(0.12)
    ev(Quartz.kCGEventLeftMouseDown, x_pt, y_pt, 2)
    time.sleep(0.1)
    ev(Quartz.kCGEventLeftMouseUp, x_pt, y_pt, 2)

if __name__ == "__main__":
    x, y = float(sys.argv[1]) / 2.0, float(sys.argv[2]) / 2.0
    dbl = len(sys.argv) > 3 and sys.argv[3] == "double"
    (double if dbl else click)(x, y)
