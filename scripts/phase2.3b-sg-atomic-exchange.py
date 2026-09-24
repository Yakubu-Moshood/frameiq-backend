#!/usr/bin/env python3
import ctypes
import os
import sys

if len(sys.argv) != 3:
    raise SystemExit('usage: atomic-exchange.py ACTIVE CANDIDATE')
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, 'renameat2', None)
if renameat2 is None:
    raise SystemExit('ATOMIC_EXCHANGE_UNAVAILABLE: libc has no renameat2')
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
result = renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 2)
if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
