import sys, time, paramiko

HOST = "66.29.152.3"
USER = "root"
PASS = "3aEu32tTj4c7IkNRT6"

def run(cmd, timeout=300):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASS, timeout=20, banner_timeout=20)
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    c.close()
    return code, out, err

if __name__ == "__main__":
    cmd = sys.argv[1]
    t = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    code, out, err = run(cmd, t)
    if out: print(out, end="")
    if err: print(err, end="", file=sys.stderr)
    sys.exit(code)
