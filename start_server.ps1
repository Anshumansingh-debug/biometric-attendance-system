$workDir = "C:\Users\LENOVO\Documents\HighflowAttendance"
$logOut  = Join-Path $workDir "server_out.log"
$logErr  = Join-Path $workDir "server_err.log"

Start-Process -FilePath "node" `
    -ArgumentList "server.js" `
    -WorkingDirectory $workDir `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError  $logErr `
    -WindowStyle Hidden
