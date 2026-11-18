#!/usr/bin/env python3
"""Inlines shared + page assets into self-contained index.html / Admin.html (CSP-friendly: nonce placeholder, no inline handlers)."""
import pathlib,sys
d=pathlib.Path(__file__).parent;out=d.parent
shared_css=(d/'shared.css').read_text();shared_js=(d/'shared.js').read_text()
def build(name,title,css,js,body=''):
    h=f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#06080f"><meta name="aryan-api-base" content=""><title>ARYAN • {title}</title>
<style>{shared_css}
{css}</style></head><body><div id="root">{body}</div><div id="toasts" role="status"></div>
<script nonce="__NONCE__">{shared_js}
{js}</script></body></html>'''
    (out/name).write_text(h);print(name,len(h)//1024,'KB')
build('index.html','Digital Store',(d/'index.css').read_text(),(d/'index.js').read_text())
if (d/'admin.js').exists():
    build('Admin.html','Admin Panel',(d/'admin.css').read_text(),(d/'admin.js').read_text())
