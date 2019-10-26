#!/bin/bash

#tell grid engine to use current directory
#$ -cwd

node bot.js --nolog --startchallenging --ranked --net update
