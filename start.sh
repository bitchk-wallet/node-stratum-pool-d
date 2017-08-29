#!/bin/bash
BITCORE="node"
run_program ()
{
  nodefile=$1
  cmd=$2
  pidfile=$3
  logfile=$4

  if [ -e "$pidfile" ]
  then
    echo "$nodefile is already running. Run 'stop' if you wish to restart."
    return 0
  fi

  nohup $nodefile $cmd >> $logfile 2>&1 &
  PID=$!
  if [ $? -eq 0 ]
  then
    echo "Successfully started $nodefile. PID=$PID. Logs are at $logfile"
    echo $PID > $pidfile
    return 0
  else
    echo "Could not start $nodefile - check logs at $logfile"
    exit 1
  fi
}

run_program $BITCORE init.js pids/insight.pid logs/insight.log