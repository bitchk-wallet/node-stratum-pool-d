var fs = require('fs');

var redis = require('redis');
var async = require('async');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');


module.exports = function (logger) {

    var poolConfigs = JSON.parse(process.env.pools);

    var enabledPools = [];

    Object.keys(poolConfigs).forEach(function (coin) {
        var poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing &&
            poolOptions.paymentProcessing.enabled)
            enabledPools.push(coin);
    });

    async.filter(enabledPools, function (coin, callback) {
        SetupForPool(logger, poolConfigs[coin], function (setupResults) {
            callback(setupResults);
        });
    }, function (coins) {
        coins.forEach(function (coin) {

            var poolOptions = poolConfigs[coin];
            var processingConfig = poolOptions.paymentProcessing;
            var logSystem = 'Payments';
            var logComponent = coin;

            logger.debug(logSystem, logComponent, 'Payment processing setup to run every ' +
                processingConfig.paymentInterval + ' second(s) with daemon (' +
                processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port +
                ') and redis (' + poolOptions.redis.host + ':' + poolOptions.redis.port + ')');

        });
    });
};


function SetupForPool(logger, poolOptions, setupFinished) {


    var coin = poolOptions.coin.name;
    var processingConfig = poolOptions.paymentProcessing;

    var logSystem = 'Payments';
    var logComponent = coin;

    var daemon = new Stratum.daemon.interface([processingConfig.daemon], function (severity, message) {
        logger[severity](logSystem, logComponent, message);
    });
    var redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);

    var magnitude;
    var minPaymentSatoshis;
    var coinPrecision;

    var paymentInterval;

    async.parallel([
        function (callback) {
            daemon.cmd('validateaddress', [poolOptions.address], function (result) {
                if (result.error) {
                    logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                    callback(true);
                } else if (!result.response || !result.response.ismine) {
                    logger.error(logSystem, logComponent,
                        'Daemon does not own pool address - payment processing can not be done with this daemon, ' +
                        JSON.stringify(result.response));
                    callback(true);
                } else {
                    callback()
                }
            }, true);
        },
        function (callback) {
            daemon.cmd('getbalance', [], function (result) {
                if (result.error) {
                    callback(true);
                    return;
                }
                try {
                    var d = result.data.split('result":')[1].split(',')[0].split('.')[1];
                    magnitude = parseInt('10' + new Array(d.length).join('0'));
                    minPaymentSatoshis = parseInt(processingConfig.minimumPayment * magnitude);
                    coinPrecision = magnitude.toString().length - 1;
                    callback();
                } catch (e) {
                    logger.error(logSystem, logComponent, 'Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: ' + result.data);
                    callback(true);
                }

            }, true, true);
        }
    ], function (err) {
        if (err) {
            setupFinished(false);
            return;
        }
        paymentInterval = setInterval(function () {
            try {
                processPayments();
            } catch (e) {
                throw e;
            }
        }, processingConfig.paymentInterval * 1000);
        setTimeout(processPayments, 100);
        setupFinished(true);
    });




    var satoshisToCoins = function (satoshis) {
        return parseFloat((satoshis / magnitude).toFixed(coinPrecision));
    };

    var coinsToSatoshies = function (coins) {
        return coins * magnitude;
    };

    /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    var processPayments = function () {

        var startPaymentProcess = Date.now();

        var timeSpentRPC = 0;
        var timeSpentRedis = 0;

        var startTimeRedis;
        var startTimeRPC;

        var startRedisTimer = function () {
            startTimeRedis = Date.now()
        };
        var endRedisTimer = function () {
            timeSpentRedis += Date.now() - startTimeRedis
        };

        var startRPCTimer = function () {
            startTimeRPC = Date.now();
        };
        var endRPCTimer = function () {
            timeSpentRPC += Date.now() - startTimeRedis
        };
        console.log("\n\n\n\n\n\n\n\n START WATER FALL");
        async.waterfall([

            /* Call redis to get an array of rounds - which are coinbase transactions and block heights from submitted
               blocks. */
            function collectRound(callback) {

                startRedisTimer();
                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocksPending']
                ]).exec(function (error, results) {
                    endRedisTimer();

                    if (error) {
                        logger.error(logSystem, logComponent, 'Could not get blocks from redis ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }



                    var workers = {};
                    for (var w in results[0]) {
                        workers[w] = {
                            balance: coinsToSatoshies(parseFloat(results[0][w]))
                        };
                        
                    }

                    var rounds = results[1].map(function (r) {
                        var details = r.split(':');
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
                            serialized: r
                        };
                    });
                    const LIMIT = 500; // debug
                    if (rounds.length > LIMIT) {
                        rounds = rounds.slice(0, LIMIT);
                        //console.log("round #1 ", rounds);
                    }
                    callback(null, workers, rounds);
                });
            },

            /* Does a batch rpc call to daemon with all the transaction hashes to see if they are confirmed yet.
               It also adds the block reward amount to the round object - which the daemon gives also gives us. */
            function rpcRound(workers, rounds, callback) {
                console.log('# 2 rounds size', rounds.length);
                var batchRPCcommand = rounds.map(function (r) {
                    return ['gettransaction', [r.txHash]];
                });

                batchRPCcommand.push(['getaccount', [poolOptions.address]]);

                startRPCTimer();

                daemon.batchCmd(batchRPCcommand, function (error, txDetails) {
                    endRPCTimer();

                    if (error || !txDetails) {
                        logger.error(logSystem, logComponent, 'Check finished - daemon rpc error with batch gettransactions ' +
                            JSON.stringify(error));
                        callback(true);
                        return;
                    } else {
                        // console.log("result >>> ");
                        // console.log("COMAND RESULT" ,txDetails);
                        // console.log("result <<< ");
                    }

                    var addressAccount;

                    txDetails.forEach(function (tx, i) {

                        if (i === txDetails.length - 1) {
                            addressAccount = tx.result; // account request , may null or "";
                            return;
                        }

                        var round = rounds[i];

                        if (tx.error && tx.error.code === -5) {
                            logger.warning(logSystem, logComponent, 'Daemon reports invalid transaction: ' + round.txHash);
                            console.log(logComponent, "error", tx.error);
                            round.category = 'kicked';
                            return;
                        } else if (!tx.result.details || (tx.result.details && tx.result.details.length === 0)) {
                            logger.warning(logComponent, 'Daemon reports no details for transaction: ' + round.txHash);

                            round.category = 'kicked';
                            return;
                        } else if (tx.error || !tx.result) {
                            console.log(logSystem, logComponent, tx.error);
                            logger.error(logSystem, logComponent, 'Odd error with gettransaction ' + round.txHash + ' ' +
                                JSON.stringify(tx));
                            return;
                        }

                        var generationTx = tx.result.details.filter(function (tx) {
                            return tx.address === poolOptions.address;
                        })[0];


                        if (!generationTx && tx.result.details.length === 1) {
                            generationTx = tx.result.details[0];
                        }

                        if (!generationTx) {
                            logger.error(logSystem, logComponent, 'Missing output details to pool address for transaction ' +
                                round.txHash);
                            return;
                        }

                        round.category = generationTx.category;
                        if (round.category === 'generate') {
                            round.reward = generationTx.amount || generationTx.value;
                        }

                    });

                    var canDeleteShares = function (r) {
                        for (var i = 0; i < rounds.length; i++) {
                            var compareR = rounds[i];
                            if ((compareR.height === r.height) &&
                                (compareR.category !== 'kicked') &&
                                (compareR.category !== 'orphan') &&
                                (compareR.serialized !== r.serialized)) {
                                return false;
                            }
                        }
                        return true;
                    };


                    //Filter out all rounds that are immature (not confirmed or orphaned yet)
                    rounds = rounds.filter(function (r) {
                        switch (r.category) {
                            case 'orphan':
                            case 'kicked':
                                r.canDeleteShares = canDeleteShares(r);
                            case 'generate':
                                return true;
                            default:
                                return false;
                        }
                    });

                    console.log('rounds last....', rounds.length);

                    callback(null, workers, rounds, addressAccount);

                });
            },


            /* Does a batch redis call to get shares contributed to each round. Then calculates the reward
               amount owned to each miner for each round. 
               addressAccount : 돈을 빼올 주소의 계정.
               */
            function checkRound(workers, rounds, addressAccount, callback) {

                console.log("# checkRound. >>>>>>>>>>>>>");
                // find shares...
                var shareLookups = rounds.map(function (r) {
                    return ['hgetall', coin + ':shares:round' + r.height]
                });

                startRedisTimer();
                redisClient.multi(shareLookups).exec(function (error, allWorkerShares) {
                    endRedisTimer();
                    // allWorkersShares... 
                    if (error) {
                        callback('Check finished - redis error with multi get rounds share');
                        return;
                    }

                    //넘어온 라운드를 뒤진다.
                    rounds.forEach(function (round, i) {
                        var workerShares = allWorkerShares[i];

                        if (!workerShares) {
                            logger.error(logSystem, logComponent, 'No worker shares for round: ' +
                                round.height + ' blockHash: ' + round.blockHash);
                            return;
                        }

                        switch (round.category) {
                            case 'kicked':
                            case 'orphan':
                                // 잘못된 작업이면, 해당 쉬어를 저장한다.
                                round.workerShares = workerShares;
                                console.log("invalid round", round);
                                break;

                            case 'generate':
                                /* We found a confirmed block! Now get the reward for it and calculate how much
                                   we owe each miner based on the shares they submitted during that block round. */
                                var reward = parseInt(round.reward * magnitude);

                                var totalShares = Object.keys(workerShares).reduce(function (p, c) {
                                    return p + parseFloat(workerShares[c])
                                }, 0);
                                /**
                                 * 사용자별 보상 을 구성한다.
                                 */
                                for (var workerAddress in workerShares) {
                                    var percent = parseFloat(workerShares[workerAddress]) / totalShares;
                                    var workerRewardTotal = Math.floor(reward * percent);
                                    var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                    worker.reward = (worker.reward || 0) + workerRewardTotal;
                                }

                                break;
                        }
                    });
                    console.log("end checkRound <<<<<<")
                    callback(null, workers, rounds, addressAccount);
                });
            },
            // remove kicked or orphan round shares
            function removeKicked(workers, rounds, addressAccount, callback) {
                console.log("# removeKicked ===>" ,workers);
                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];
                // 완료된쉐어 정리...
                var moveSharesToCurrent = function (r) {
                    var workerShares = r.workerShares;
                    Object.keys(workerShares).forEach(function (worker) {
                        orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent',
                            worker, workerShares[worker]
                        ]);
                    });
                };

                rounds.forEach(function (r) {

                    switch (r.category) {
                        case 'kicked':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksKicked', r.serialized]);
                        case 'orphan':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksOrphaned', r.serialized]);
                            if (r.canDeleteShares) {
                                moveSharesToCurrent(r);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                            }

                            return;
                    }

                });
                var canDeleteShares = function (r) {
                    for (var i = 0; i < rounds.length; i++) {
                        var compareR = rounds[i];
                        if ((compareR.height === r.height) &&
                            (compareR.category !== 'kicked') &&
                            (compareR.category !== 'orphan') &&
                            (compareR.serialized !== r.serialized)) {
                            return false;
                        }
                    }
                    return true;
                };
                // make next step round...
                // only normal tx
                rounds = rounds.filter(function (r) {
                    switch (r.category) {
                        case 'orphan':
                        case 'kicked':
                            r.canDeleteShares = canDeleteShares(r);
                            return false;
                        case 'generate':
                            return true;
                        default:
                            return false;
                    }
                });
                var finalRedisCommands = [];

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(['del'].concat(roundsToDelete));

                logger.warning(logSystem, logComponent, "movePendingCommands:" + movePendingCommands.length + ",roundsToDelete:" + roundsToDelete.length);
                if (finalRedisCommands.length === 0) {
                    console.log("end Kicked #1 ...");
                    callback(null,workers, rounds, addressAccount);
                } else {

                    startRedisTimer();
                    redisClient.multi(finalRedisCommands).exec(function (error, results) {
                        endRedisTimer();
                        if (error) {
                            clearInterval(paymentInterval);
                            logger.error(logSystem, logComponent,
                                'Payments sent but could not update redis. ' + JSON.stringify(error) +
                                ' Disabling payment processing to prevent possible double-payouts. The redis commands in ' +
                                coin + '_finalRedisCommands.txt must be ran manually');
                            fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), function (err) {
                                logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                            });
                        }
                        console.log("end Kicked... #2");
                        callback(null,workers, rounds, addressAccount);
                    });
                }
            },

            /* Calculate if any payments are ready to be sent and trigger them sending
             Get balance different for each address and pass it along as object of latest balances such as
             {worker1: balance1, worker2, balance2}
             when deciding the sent balance, it the difference should be -1*amount they had in db,
             if not sending the balance, the differnce should be +(the amount they earned this round)
             */
            function sendPay(workers, rounds, addressAccount, callback) {
                console.log("#sendPay >>>>");
                // 작업자들과 라운드가 들어 왔다. 

                /**
                 * 전송을 시도한다. 
                 * 자금이 모자랄경우 루프를 돈다.
                 * @param {*} withholdPercent 
                 * @param {*} callCnt 
                 */
                var trySend = function (withholdPercent, callCnt) {
                    if (callCnt > 1) {
                        console.log('callCnt', callCnt);
                    }
                    var addressAmounts = {};
                    var totalSent = 0;
                    // set max 
                    for (var w in workers) {

                        var worker = workers[w];
                        worker.balance = worker.balance || 0;
                        worker.reward = worker.reward || 0;
                        var toSend = (worker.balance + worker.reward) * (1 - withholdPercent);
                        if (toSend >= minPaymentSatoshis) { //전송...
                            totalSent += toSend;
                            var address = worker.address = (worker.address || getProperAddress(w));
                            worker.sent = addressAmounts[address] = satoshisToCoins(toSend); // 전송할 자금...
                            worker.balanceChange = Math.min(worker.balance, toSend) * -1;
                        } else {
                            worker.balanceChange = Math.max(toSend - worker.balance, 0);
                            if (worker.balanceChange < 0) {
                                console.log(worker.balance, toSend);
                            }
                            worker.sent = 0;
                        }
                        

                    }

                    if (Object.keys(addressAmounts).length === 0) {
                        console.log("skip no pay... sendpay <<<<<<<<<");
                        callback(null, workers, rounds);
                        return;
                    }

                    daemon.cmd('sendmany', [addressAccount || '', addressAmounts], function (result) {
                        //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                        // 자금부족.
                        if (result.error && result.error.code === -6) {
                            var higherPercent = withholdPercent + 0.01;
                            console.log("sendmany fail" ,addressAmounts);
                            if (higherPercent > 1.0) {
                                higherPercent = 1.0;
                            }
                            logger.warning(logSystem, logComponent, 'Not enough funds to cover the tx fees for sending out payments, decreasing rewards by ' +
                                (higherPercent * 100) + '% and retrying');

                            trySend(higherPercent, callCnt++);
                        } else if (result.error) {
                            // 전송오류....
                            // 너무 많은 거래나 너무큰 자금일 경우 문제가 발생한다.
                            logger.error(logSystem, logComponent, 'Error trying to send payments with RPC sendmany \n\t' +
                                JSON.stringify(result.error));
                            console.log("sendmany fail ", addressAccount, addressAmounts);
                            callback(true);
                        } else {
                            logger.debug(logSystem, logComponent, 'Sent out a total of ' + (totalSent / magnitude) +
                                ' to ' + Object.keys(addressAmounts).length + ' workers');
                            if (withholdPercent > 0) {
                                logger.warning(logSystem, logComponent, 'Had to withhold ' + (withholdPercent * 100) +
                                    '% of reward from miners to cover transaction fees. ' +
                                    'Fund pool wallet with coins to prevent this from happening');
                            }
                            callback(null, workers, rounds);
                        }
                    }, true, true);
                };
                trySend(0);

            },
            // 정리...  위에서 오류가 발생하면 오지 않아서 쉐어가 쌓인다.
            // 중간에 잘못된 쉐어에 대한 처리를 진행한다.
            // 잘못된 쉐어가 다른곳에서 계산되어지는지 확인해야 한다.
            function clearRound(workers, rounds, callback) {
                console.log("clearRound >>", workers);
                var totalPaid = 0;

                var balanceUpdateCommands = [];
                var workerPayoutsCommand = [];

                for (var w in workers) {
                    var worker = workers[w];
                    if (worker.balanceChange !== 0) {
                        balanceUpdateCommands.push([
                            'hincrbyfloat',
                            coin + ':balances',
                            w,
                            satoshisToCoins(worker.balanceChange)
                        ]);
                    }
                    if (worker.sent !== 0) { // 전달되었으면 payout 에 넣는다.
                        workerPayoutsCommand.push(['hincrbyfloat', coin + ':payouts', w, worker.sent]);
                        totalPaid += worker.sent;
                    }
                }



                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];
                // 완료된쉐어 정리...
                var moveSharesToCurrent = function (r) {
                    var workerShares = r.workerShares;
                    Object.keys(workerShares).forEach(function (worker) {
                        orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent',
                            worker, workerShares[worker]
                        ]);
                    });
                };
                rounds.forEach(function (r) {

                    switch (r.category) {
                        case 'kicked':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksKicked', r.serialized]);
                        case 'orphan':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksOrphaned', r.serialized]);
                            if (r.canDeleteShares) {
                                moveSharesToCurrent(r);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                            }
                            return;
                        case 'generate':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksConfirmed', r.serialized]);
                            roundsToDelete.push(coin + ':shares:round' + r.height);
                            return;
                    }

                });

                var finalRedisCommands = [];

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (balanceUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

                if (workerPayoutsCommand.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(['del'].concat(roundsToDelete));

                if (totalPaid !== 0)
                    finalRedisCommands.push(['hincrbyfloat', coin + ':stats', 'totalPaid', totalPaid]);

                if (finalRedisCommands.length === 0) {
                    console.log("clearRound end no redis<<<<<");
                    callback();
                    return;
                }

                startRedisTimer();
                redisClient.multi(finalRedisCommands).exec(function (error, results) {
                    endRedisTimer();
                    if (error) {
                        clearInterval(paymentInterval);
                        logger.error(logSystem, logComponent,
                            'Payments sent but could not update redis. ' + JSON.stringify(error) +
                            ' Disabling payment processing to prevent possible double-payouts. The redis commands in ' +
                            coin + '_finalRedisCommands.txt must be ran manually');
                        fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), function (err) {
                            logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                        });
                    }
                    callback();
                    console.log("clearRound end with redis <<<<<");
                });

            }

        ], function end() {

            var paymentProcessTime = Date.now() - startPaymentProcess;
            logger.debug(logSystem, logComponent, 'Finished interval - time spent: ' +
                paymentProcessTime + 'ms total, ' + timeSpentRedis + 'ms redis, ' +
                timeSpentRPC + 'ms daemon RPC');

        });
    };


    var getProperAddress = function (address) {
        if (address.length === 40) {
            return util.addressFromEx(poolOptions.address, address);
        } else return address;
    };


}