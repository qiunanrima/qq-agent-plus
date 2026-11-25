#!/usr/bin/python3
"""One request per systemd-accepted Unix stream. Docker target and flags are fixed."""
import json
import subprocess
import sys

TARGET = 'qq-agent-linux-workspace'


def docker(*args):
    subprocess.run(['/usr/bin/docker', *args], check=True, stdout=subprocess.DEVNULL, timeout=30)


def handle(req):
    if req['action'] == 'configure':
        if req['enabled'] is False:
            docker('stop', TARGET)
        elif req['enabled'] is True:
            cpu, memory, pids = (req[key] for key in ('cpu', 'memory', 'pids'))
            if (type(cpu) not in (float, int) or not 0.1 <= cpu <= 4
                    or type(memory) is not int or not 64 <= memory <= 4096
                    or type(pids) is not int or not 16 <= pids <= 1024):
                raise ValueError('资源限制超出范围')
            docker('update', '--cpus', str(cpu), '--memory', f'{memory}m',
                   '--memory-swap', f'{memory}m', '--pids-limit', str(pids), TARGET)
            docker('start', TARGET)
        else:
            raise ValueError('enabled must be boolean')
        return {'ok': True}
    if req['action'] != 'exec' or not isinstance(req.get('command'), str) or len(req['command'].encode()) > 8192:
        raise ValueError('invalid command')
    with subprocess.Popen(['/usr/bin/docker', 'exec', '-u', '0', TARGET,
                           '/usr/bin/timeout', '-k', '2', '30', '/bin/sh', '-c', req['command']],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as proc:
        output = bytearray()
        truncated = False
        while chunk := proc.stdout.read(8192):
            room = 32768 - len(output)
            output.extend(chunk[:room])
            truncated |= len(chunk) > room
        return {'code': proc.wait(), 'output': output.decode(errors='replace') + ('\n[输出已截断]' if truncated else '')}


try:
    result = handle(json.loads(sys.stdin.buffer.readline(65536)))
except Exception as exc:
    result = {'error': str(exc)}
print(json.dumps(result, ensure_ascii=False))
