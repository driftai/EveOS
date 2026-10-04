'use strict';
const{runDriver}=require('./terminal-driver-core');
runDriver().catch((error)=>{console.error(error?.stack||error);process.exitCode=1;});
