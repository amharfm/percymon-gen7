
//@@
var _dex = require('./battle-engine/dex');
var toId = _dex.Dex.getId;
var _dexdata = require('./battle-engine/dex-data'); var Data = _dexdata;


// Class libary
JS = require('jsclass');
JS.require('JS.Class');

//does this work? will it show up?

require("sugar");

// Account file
var bot = require("./bot.js");
var account = bot.account;

// Results database
var db = require("./db");

// Logging
var log4js = require('log4js');
var logger = require('log4js').getLogger("battleroom");
var decisionslogger = require('log4js').getLogger("decisions");

//battle-engine
//@@
var Battle = require('./battle-engine/battle');
var BattlePokemon = require('./battle-engine/pokemon');

var Abilities = require("./data/abilities").BattleAbilities;
var Items = require("./data/items").BattleItems;
var Moves = require("./data/moves").BattleMovedex;
// var Moves = require("require-from-url/sync")("https://play.pokemonshowdown.com/data/moves.js").BattleMovedex;

var _ = require("underscore");

var clone = require("./clone");

var program = require('commander'); // Get Command-line arguments

var BattleRoom = new JS.Class({
    initialize: function(id, sendfunc) {
        this.id = id;
        this.title = "Untitled";
        this.send = sendfunc;

        // Construct a battle object that we will modify as our state
        //@@
        this.state = new Battle.Battle(id, 'base', false);
        this.state.join('p1', 'botPlayer'); // We will be player 1 in our local simulation
        this.state.join('p2', 'humanPlayer');
        this.state.reportPercentages = true;

        this.previousState = null; // For TD Learning

        setTimeout(function() {
            sendfunc(account.message, id); // Notify User that this is a bot
            sendfunc("/timer", id); // Start timer (for user leaving or bot screw ups)
        }, 10000);

        this.decisions = [];
        this.log = "";

        this.state.start();
    },
    init: function(data) {
        var log = data.split('\n');
        if (data.substr(0, 6) === '|init|') {
            log.shift();
        }
        if (log.length && log[0].substr(0, 7) === '|title|') {
            this.title = log[0].substr(7);
            log.shift();
            logger.info("Title for " + this.id + " is " + this.title);
        }
    },
    //given a player and a pokemon, returns the corresponding pokemon object
    getPokemon: function(battleside, pokename, whats) {
        // @@
        for(var i = 0; i < battleside.pokemon.length; i++) {
            if(battleside.pokemon[i].name === pokename || //for mega pokemon
               battleside.pokemon[i].name.substr(0,pokename.length) === pokename){
                return battleside.pokemon[i];}
                    else if (battleside.pokemon[i].name!=pokename && pokename!='Bulbasaur'){
                        return battleside.pokemon[i];}
                else {
                    return undefined;
                }
        }
    },
    //given a player and a pokemon, updates that pokemon in the battleside object
    updatePokemon: function(battleside, pokemon) {
        for(var i = 0; i < battleside.pokemon.length; i++) {
            if (pokemon) if(battleside.pokemon[i].name === pokemon.name) {
                battleside.pokemon[i] = pokemon;
                return;
            }
        }
        logger.info("Could not find " + pokemon.name + " in the battle side, creating new Pokemon.");
        for(var i = battleside.pokemon.length - 1; i >= 0; i--) {
            if(battleside.pokemon[i].name === "Bulbasaur") {
                battleside.pokemon[i] = pokemon;
                return;
            }
        }
    },

    //returns true if the player object is us
    isPlayer: function(player) {
        return player === this.side + 'a:' || player === this.side + ':';
    },
    // TODO: Understand more about the opposing pokemon
    updatePokemonOnSwitch: function(tokens) {
        var tokens2 = tokens[2].split(' ');

        //^&^&^&^
        if (tokens[3].split(', ')[1]) var level = tokens[3].split(', ')[1].substring(1); else var level = 101;

        var tokens4 = tokens[4].split(/\/| /); //for health

        var player = tokens2[0];
        var pokeName = tokens2[1];
        var health = tokens4[0];
        var maxHealth = tokens4[1];

        var battleside = undefined;

        if (this.isPlayer(player)) {
            logger.info("Our pokemon has switched! " + tokens[2]);
            battleside = this.state.p1;
            //remove boosts for current pokemon
            this.state.p1.active[0].clearVolatile();
        } else {
            logger.info("Opponents pokemon has switched! " + tokens[2]);
            battleside = this.state.p2;
            //remove boosts for current pokemon
            this.state.p2.active[0].clearVolatile();
        }
        var pokemon = this.getPokemon(battleside, pokeName);

        if(!pokemon) { //pokemon has not been defined yet, so choose Bulbasaur
            //note: this will not quite work if the pokemon is actually Bulbasaur
            pokemon = this.getPokemon(battleside, "Bulbasaur");
            var set = this.state.getTemplate(pokeName);
            set.moves = set.randomBattleMoves;
            //set.moves = _.sample(set.randomBattleMoves, 4); //for efficiency, need to implement move ordering
            set.level = parseInt(level);
            //choose the best ability
            var abilities = Object.values(set.abilities).sort(function(a,b) {
                return this.state.getAbility(b).rating - this.state.getAbility(a).rating;
            }.bind(this));
            set.ability = abilities[0];
            pokemon = new BattlePokemon(set, battleside);
            pokemon.trueMoves = []; //gradually add moves as they are seen
        }
        //opponent hp is recorded as percentage
        pokemon.hp = Math.ceil(health / maxHealth * pokemon.maxhp);
        pokemon.position = 0;

        battleside.active[0].isActive = false;
        pokemon.isActive = true;
        this.updatePokemon(battleside,pokemon);

        battleside.active = [pokemon];

        //Ensure that active pokemon is in slot zero
        battleside.pokemon = _.sortBy(battleside.pokemon, function(pokemon) { return pokemon == battleside.active[0] ? 0 : 1 });
    },
    updatePokemonOnMove: function(tokens) {
        var tokens2 = tokens[2].split(' ');
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var move = tokens[3];
        var battleside = undefined;

        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }

        var pokemon = this.getPokemon(battleside, pokeName);
        if(!pokemon) {
            logger.error("We have never seen " + pokeName + " before in this battle. Should not have happened.");
            return;
        }

        //update last move (doesn't actually affect the bot...)
        pokemon.lastMove = toId(move);

        //if move is protect or detect, update stall counter
        if('stall' in pokemon.volatiles) {
            pokemon.volatiles.stall.counter++;
        }
        //update status duration
        if(pokemon.status) {
            pokemon.statusData.duration = (pokemon.statusData.duration?
            pokemon.statusData.duration+1:
            1);
        }
        //we are no longer newly switched (so we don't fakeout after the first turn)
        pokemon.activeTurns += 1;
        if(!this.isPlayer(player)) { //anticipate more about the Pokemon's moves
            //@@
            if (pokemon) if (pokemon.trueMoves) if(pokemon.trueMoves.indexOf(toId(move)) < 0 && pokemon.trueMoves.length < 4) {
                pokemon.trueMoves.push(toId(move));
                logger.info("Determined that " + pokeName + " can use " + toId(move));
                //if we have collected all of the moves, eliminate all other possibilities
                if(pokemon.trueMoves.length >= 4) {
                    logger.info("Collected all of " + pokeName + "'s moves!");
                    var newMoves = [];
                    var newMoveset = [];
                    for(var i = 0; i < pokemon.moveset.length; i++) {
                        if(pokemon.trueMoves.indexOf(pokemon.moveset[i].id) >= 0) {
                            newMoves.push(pokemon.moveset[i].id); //store id
                            newMoveset.push(pokemon.moveset[i]);  //store actual moves
                        }
                    }
                    pokemon.moves = newMoves;
                    pokemon.moveset = newMoveset;
                }

            }
        }

        this.updatePokemon(battleside, pokemon);

    },
    updatePokemonOnDamage: function(tokens) {
        //extract damage dealt to a particular pokemon
        //also takes into account passives
        //note that opponent health is recorded as percent. Keep this in mind

        var tokens2 = tokens[2].split(' ');
        var tokens3 = tokens[3].split(/\/| /);
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var health = tokens3[0];
        var maxHealth = tokens3[1];
        var battleside = undefined;

        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }

        var pokemon = this.getPokemon(battleside, pokeName);
        if(!pokemon) {
            logger.error("We have never seen " + pokeName + " before in this battle. Should not have happened.");
            return;
        }

        //update hp
        pokemon.hp = Math.ceil(health / maxHealth * pokemon.maxhp);
        this.updatePokemon(battleside, pokemon);

    },
    updatePokemonOnBoost: function(tokens, isBoost) {
        var tokens2 = tokens[2].split(' ');
        var stat = tokens[3];
        var boostCount = parseInt(tokens[4]);
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var battleside = undefined;

        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }

        var pokemon = this.getPokemon(battleside, pokeName);
        if(!pokemon) {
            logger.error("We have never seen " + pokeName + " before in this battle. Should not have happened.");
            return;
        }

        if(isBoost) {
            if(stat in pokemon.boosts)
                pokemon.boosts[stat] += boostCount;
            else
                pokemon.boosts[stat] = boostCount;
        } else {
            if(stat in pokemon.boosts)
                pokemon.boosts[stat] -= boostCount;
            else
                pokemon.boosts[stat] = -boostCount;
        }
        this.updatePokemon(battleside, pokemon);
    },
    updatePokemonSetBoost: function(tokens) {
        var tokens2 = tokens[2].split(' ');
        var stat = tokens[3];
        var boostCount = parseInt(tokens[4]);
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var battleside = undefined;

        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }

        var pokemon = this.getPokemon(battleside, pokeName);
        if(!pokemon) {
            logger.error("We have never seen " + pokeName + " before in this battle. Should not have happened.");
            return;
        }

        pokemon.boosts[stat] = boostCount;
        this.updatePokemon(battleside, pokemon);
    },
    updatePokemonRestoreBoost: function(tokens) {
        var tokens2 = tokens[2].split(' ');
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var battleside = undefined;

        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }

        var pokemon = this.getPokemon(battleside, pokeName);
        if(!pokemon) {
            logger.error("We have never seen " + pokeName + " before in this battle. Should not have happened.");
            return;
        }

        for(var stat in pokemon.boosts) {
            if(pokemon.boosts[stat] < 0)
                delete pokemon.boosts[stat];
        }
        this.updatePokemon(battleside, pokemon);


    },
    updatePokemonStart: function(tokens, newStatus) {
        //add condition such as leech seed, substitute, ability, confusion, encore
        //move: yawn, etc.
        //ability: flash fire, etc.

        var tokens2 = tokens[2].split(' ');
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var status = tokens[3];
        var battleside = undefined;

        //@@
        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }
        
        var pokemon = this.getPokemon(battleside, pokeName);

        if(status.substring(0,4) === 'move') {
            status = status.substring(6);
        } else if(status.substring(0,7) === 'ability') {
            status = status.substring(9);
        }

        if(newStatus) {
            pokemon.addVolatile(status);
        } else {
            pokemon.removeVolatile(status);
        }
        this.updatePokemon(battleside, pokemon);
    },
    updateField: function(tokens, newField) {
        //as far as I know, only applies to trick room, which is a pseudo-weather
        var fieldStatus = tokens[2].substring(6);
        if(newField) {
            this.state.field.addPseudoWeather(fieldStatus);
        } else {
            this.state.field.removePseudoWeather(fieldStatus);
        }
    },
    updateWeather: function(tokens) {
        //@@
        var weather = tokens[2];
        if(weather === "none") {
            this.state.field.clearWeather();
        } else {
            this.state.field.setWeather(weather);
        }
    },
    updateSideCondition: function(tokens, newSide) {
        
        var player = tokens[2].split(' ')[0];   
        var sideStatus = tokens[3];             
        if(sideStatus.substring(0,4) === "move")
            sideStatus = tokens[3].substring(6);
        var battleside = undefined;
        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }
        
        if(newSide) {
            //@@
            battleside.addSideCondition(sideStatus, this.getPokemon(battleside, battleside.active[0].name), _dex.Dex.getActiveMove(sideStatus));
            //Note: can have multiple layers of toxic spikes or spikes
        } else {
            battleside.removeSideCondition(sideStatus);
            //remove side status
        }
    },
    updatePokemonStatus: function(tokens, newStatus) {
        var tokens2 = tokens[2].split(' ');
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var status = tokens[3];
        var battleside = undefined;

        // @@
        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }

        var pokemon = this.getPokemon(battleside, pokeName);
        
        if(newStatus) {
            pokemon.setStatus(status);
            //record a new Pokemon's status
            //also keep track of how long the status has been going? relevant for toxic poison
            //actually, might be done by default
        } else {
            pokemon.clearStatus();
            //heal a Pokemon's status
        }
        this.updatePokemon(battleside, pokemon);
        
    },
    updatePokemonOnItem: function(tokens, newItem) {
        //record that a pokemon has an item. Most relevant if a Pokemon has an air balloon/chesto berry
        //TODO: try to predict the opponent's current item

        var tokens2 = tokens[2].split(' ');
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var item = tokens[3];
        var battleside = undefined;

        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }
        //@@
        var pokemon = this.getPokemon(battleside, pokeName);

        if(newItem) {
            pokemon.setItem(item);
        } else {
            pokemon.clearItem(item);
        }
        this.updatePokemon(battleside, pokemon);
    },

    //Apply mega evolution effects, or aegislash/meloetta
    updatePokemonOnFormeChange: function(tokens) {
        var tokens2 = tokens[2].split(' ');
        var tokens3 = tokens[3].split(', ');
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var newPokeName = tokens3[0];
        var battleside = undefined;

        if(this.isPlayer(player)) {
            battleside = this.state.p1;
        } else {
            battleside = this.state.p2;
        }
        //Note: crashes when the bot mega evolves.
        //@@
        logger.info(pokeName + " has transformed into " + newPokeName + "!");
        var pokemon = this.getPokemon(battleside, pokeName, true);

        //apply forme change
        pokemon.formeChange(newPokeName);
        this.updatePokemon(battleside, pokemon);
    },
    //for ditto exclusively
    updatePokemonOnTransform: function(tokens) {
        var tokens2 = tokens[2].split(' ');
        var tokens3 = tokens[3].split(' ');
        var player = tokens2[0];
        var pokeName = tokens2[1];
        var newPokeName = tokens3[1];
        var battleside = undefined;
        var pokemon = undefined;

        if(this.isPlayer(player)) {
            battleside = this.state.p1;
            pokemon = this.getPokemon(battleside, pokeName);
            pokemon.transformInto(this.state.p2.active[0]);
        } else {
            battleside = this.state.p2;
            pokemon = this.getPokemon(battleside, pokeName);
            pokemon.transformInto(this.state.p1.active[0]);
        }
        this.updatePokemon(battleside, pokemon);

    },
    recieve: function(data) {
        var ai = this;
        if (!this.firstPokeId) this.firstPokeId = 0;
        //@@

        if (!data) return;

        logger.trace("<< " + data);

        if (data.substr(0, 6) === '|init|') {
            return this.init(data);
        }
        if (data.substr(0, 9) === '|request|') {
            if (data.substr(9)==""){
                // console.log('waaaait....')
                return ;
            } else {
                if (JSON.parse(data.substr(9)).teamPreview){
                    ai.teamP = JSON.parse(data.substr(9));
                    return ai.receiveRequest(JSON.parse(data.substr(9)));
                } else {
                    return ai.receiveRequest(JSON.parse(data.substr(9)));
                }
            }
        }

        var log = data.split('\n');
        for (var i = 0; i < log.length; i++) {
            this.log += log[i] + "\n";

            var tokens = log[i].split('|');
            if (tokens.length > 1) {

                if (tokens[1] === 'tier') {
                    this.tier = tokens[2];
                } else if (tokens[1] === 'win') {
                    //@@
                    var ggg = "[auto] thamks for playing w/ AI. Credits: Percymon: A Pokemon Showdown AI";
                    this.send(ggg, this.id)

                    this.winner = tokens[2];
                    if (this.winner == account.username) {
                        logger.info(this.title + ": I won this game");
                    } else {
                        logger.info(this.title + ": I lost this game");
                    }

                    if(program.net === "update" && this.previousState) {
                        var playerAlive = _.any(this.state.p1.pokemon, function(pokemon) { return pokemon.hp > 0; });
                        var opponentAlive = _.any(this.state.p2.pokemon, function(pokemon) { return pokemon.hp > 0; });

                        if(!playerAlive || !opponentAlive) minimaxbot.train_net(this.previousState, null, (this.winner == account.username));
                    }

                    if(!program.nosave) this.saveResult();

                    // Leave in two seconds
                    var battleroom = this;
                    setTimeout(function() {
                        battleroom.send("/leave " + battleroom.id);
                    }, 2000);

                } else if (tokens[1] === 'switch' || tokens[1] === 'drag') {
                    this.updatePokemonOnSwitch(tokens);
                } else if (tokens[1] === 'move') {
                    this.updatePokemonOnMove(tokens);
                } else if(tokens[1] === 'faint') { //we could outright remove a pokemon...
                    //record that pokemon has fainted
                } else if(tokens[1] === 'detailschange' || tokens[1] === 'formechange') {
                    this.updatePokemonOnFormeChange(tokens);
                } else if(tokens[1] === '-transform') {
                    this.updatePokemonOnTransform(tokens);
                } else if(tokens[1] === '-damage') { //Error: not getting to here...
                    this.updatePokemonOnDamage(tokens);
                } else if(tokens[1] === '-heal') {
                    this.updatePokemonOnDamage(tokens);
                } else if(tokens[1] === '-boost') {
                    this.updatePokemonOnBoost(tokens, true);
                } else if(tokens[1] === '-unboost') {
                    this.updatePokemonOnBoost(tokens, false);
                } else if(tokens[1] === '-setboost') {
                    this.updatePokemonSetBoost(tokens);
                } else if(tokens[1] === '-restoreboost') {
                    this.updatePokemonRestoreBoost(tokens);
                } else if(tokens[1] === '-start') {
                    this.updatePokemonStart(tokens, true);
                } else if(tokens[1] === '-end') {
                    this.updatePokemonStart(tokens, false);
                } else if(tokens[1] === '-fieldstart') {
                    this.updateField(tokens, true);
                } else if(tokens[1] === '-fieldend') {
                    this.updateField(tokens, false);
                } else if(tokens[1] === '-weather') {
                    this.updateWeather(tokens);
                } else if(tokens[1] === '-sidestart') {
                    this.updateSideCondition(tokens, true);
                } else if(tokens[1] === '-sideend') {
                    this.updateSideCondition(tokens, false);
                } else if(tokens[1] === '-status') {
                    this.updatePokemonStatus(tokens, true);
                } else if(tokens[1] === '-curestatus') {
                    this.updatePokemonStatus(tokens, false);
                } else if(tokens[1] === '-item') {
                    this.updatePokemonOnItem(tokens, true);
                } else if(tokens[1] === '-enditem') {
                    this.updatePokemonOnItem(tokens, false);
                } else if(tokens[1] === '-ability') {
                    //relatively situational -- important for mold breaker/teravolt, etc.
                    //needs to be recorded so that we don't accidentally lose a pokemon

                    //We don't actually care about the rest of these effects, as they are merely visual
                } else if(tokens[1] === '-supereffective') {

                } else if(tokens[1] === '-crit') {

                } else if(tokens[1] === '-singleturn') { //for protect. But we only care about damage...

                } else if(tokens[1] === 'c') {//chat message. ignore. (or should we?)

                } else if(tokens[1] === '-activate') { //protect, wonder guard, etc.

                } else if(tokens[1] === 'turn') {

                } else if(tokens[1] === '-fail') {

                } else if(tokens[1] === '-immune') {

                } else if(tokens[1] === '-resisted') {

                } else if(tokens[1] === 'upkeep') {
                    //@@ all the above & below
                } else if(tokens[1] === 'miss') {

                } else if(tokens[1] === 'message') {

                } else if(tokens[1] === 'error') {
                    this.updatePokemonOnMove(tokens);
                } else if(tokens[1] === 'cant') {

                } else if(tokens[1] === 'leave') {

                } else if(tokens[1] === 'rule') {

                } else if(tokens[1] === 'teampreview') {
                    //@@ just a simple random choice
                    var choose = "/team "+ Number(Math.floor(Math.random()*ai.teamP.side.pokemon.length) + 1);
                    ai.send(choose, ai.id)

                } else if(tokens[1] === 'gen') {

                } else if(tokens[1] === 'poke') {
                    //@@ new prop, to count the number of pokemon
                    if (!this.state[tokens[2]+'_countPokemon']) this.state[tokens[2]+'_countPokemon'] = 0;

                    this.state[tokens[2]+'_countPokemon']++;
                } else if(tokens[1] === 'clearpoke') {

                } else if(tokens[1] === 'player') {

                } else if(tokens[1] === 'teamsize') {

                } else if(tokens[1] === 'gametype') {

                } else if(tokens[1] === 'inactive') {
                    //@@
                    // ai.send("/leave " + ai.id);
                } else if(tokens[1]) { //what if token is defined
                    logger.info("Error: could not parse token '" + tokens[1] + "'. This needs to be implemented");
                }

            }
        }
    },
    saveResult: function() {
        // Save game data to data base
        game = {
            "title": this.title,
            "id": this.id,
            "win": (this.winner == account.username),
            "date": new Date(),
            "decisions": "[]", //JSON.stringify(this.decisions),
            "log": this.log,
            "tier": this.tier
        };
        db.insert(game, function(err, newDoc) {
	    if(newDoc) logger.info("Saved result of " + newDoc.title + " to database.");
	    else logger.error("Error saving result to database.");
        });
    },
    receiveRequest: function(request) {
        if (!request) {
            this.side = '';
            return;
        }

        if (request.side) this.updateSide(request.side, true);

        if (request.active) logger.info(this.title + ": I need to make a move.");
        if (request.forceSwitch) logger.info(this.title + ": I need to make a switch.");

        if (request.active || request.forceSwitch) this.makeMove(request);
    },

    //note: we should not be recreating pokemon each time
    //is this redundant?
    //@@ maybe we need to always update the limitation based on validation of current tier & number of team (?) -A
    updateSide: function(sideData) {
        var that_ = this;
        if (!sideData || !sideData.id) return;
        logger.info("Starting to update my side data.");
        
        //@@ to adjust with internet connection
        var wait = setInterval(function(){
            //@@
            if (sideData) if (sideData.pokemon.length<that_.state[sideData.id+'_countPokemon']){
            } else {
             clearInterval(wait);
             var that = that_;
             for (var i = 0; i < sideData.pokemon.length; ++i) {
                var pokemon = sideData.pokemon[i];

                var details = pokemon.details.split(",");
                var name = details[0].trim();

                //@@ new functions, to wrap the level & gender & ability & item-checking on functions
                function whatlevel (details){
                    var res = 100;
                    if (details) if (details.length>2){
                        parseInt(details[1].trim().substring(1))
                    }
                    return res;
                }
                var level = whatlevel(details);
                function whatgender (details){
                    var res = null
                    if (details) if (details.length>2){
                        details[2] ? details[2].trim() : null;
                    } else details[1] ? details[1].trim() : null;
                    return res;
                }
                var gender = whatgender(details);
                //@@
                function whatability (p){
                    var res = "";
                    if (Abilities[pokemon.baseAbility]){
                        res = Abilities[pokemon.baseAbility].name;
                    }
                    return res;
                }
                function whatitem (p){
                    var res = "";
                    if (Items[pokemon.item]){
                        res = (!pokemon.item || pokemon.item === '') ? '' : Items[pokemon.item].name
                    }            
                    return res;
                }

                var template = {
                    name: name,
                    moves: pokemon.moves,
                    ability: whatability(pokemon),
                    evs: {
                        hp: 85,
                        atk: 85,
                        def: 85,
                        spa: 85,
                        spd: 85,
                        spe: 85
                    },
                    ivs: {
                        hp: 31,
                        atk: 31,
                        def: 31,
                        spa: 31,
                        spd: 31,
                        spe: 31
                    },
                    //@@
                    item: whatitem(pokemon),//(!pokemon.item || pokemon.item === '') ? '' : Items[pokemon.item].name,
                    level: level,
                    active: pokemon.active,
                    shiny: false
                };

                //keep track of old pokemon
                var oldPokemon = that.state.p1.pokemon[i];

                // Initialize pokemon
                //@@
                that.state.p1.pokemon[i] = new BattlePokemon.Pokemon(template, that.state.p1);
                
                that.state.p1.pokemon[i].position = i;

                // Update the pokemon object with latest stats
                //@@
                for (var stat in pokemon.stats) {
                    that.state.p1.pokemon[i].baseStoredStats[stat] = pokemon.stats[stat];
                }
                // Update health/status effects, if any
                var condition = pokemon.condition.split(/\/| /);
                that.state.p1.pokemon[i].hp = parseInt(condition[0]);
                if(condition.length > 2) {//add status condition
                    that.state.p1.pokemon[i].setStatus(condition[2]); //necessary
                }
                if(oldPokemon.isActive && oldPokemon.statusData) { //keep old duration
                    pokemon.statusData = oldPokemon.statusData;
                }

                // Keep old boosts
                that.state.p1.pokemon[i].boosts = oldPokemon.boosts;

                // Keep old volatiles
                that.state.p1.pokemon[i].volatiles = oldPokemon.volatiles;

                if (pokemon.active) {
                    that.state.p1.active = [that.state.p1.pokemon[i]];
                    that.state.p1.pokemon[i].isActive = true;
                }

                // TODO(rameshvarun): Somehow parse / load in current hp and status conditions
             }
            }
        },1000)        

        // Enforce that the active pokemon is in the first slot
        this.state.p1.pokemon = _.sortBy(this.state.p1.pokemon, function(pokemon) { return pokemon.isActive ? 0 : 1 });

        this.side = sideData.id;
        this.oppSide = (this.side === "p1") ? "p2" : "p1";
        logger.info(this.title + ": My current side is " + this.side);
    },
    makeMove: function(request) {
        var room = this;

        setTimeout(function() {
            if(program.net === "update") {
                if(room.previousState != null) minimaxbot.train_net(room.previousState, room.state);
                room.previousState = clone(room.state);
            }

            var decision = BattleRoom.parseRequest(request);

            // Use specified algorithm to determine resulting choice
            var result = undefined;
            if(decision.choices.length == 1) result = decision.choices[0];
            else if(program.algorithm === "minimax") result = minimaxbot.decide(clone(room.state), decision.choices);
            else if(program.algorithm === "greedy") result = greedybot.decide(clone(room.state), decision.choices);
            else if(program.algorithm === "random") result = randombot.decide(clone(room.state), decision.choices);

            room.decisions.push(result);
            room.send("/choose " + BattleRoom.toChoiceString(result, room.state.p1) + "|" + decision.rqid, room.id);
        }, 5000);
    },
    // Static class methods
    extend: {
        toChoiceString: function(choice, battleside) {
            if (choice.type == "move") {
                //@@ check the Z item & mega evo fixes. So far so good.
                if (battleside.active[0].canMegaEvo){
                    if (battleside.active[0].speciesid.indexOf('mega')>-1){
                        return "move " + choice.id;
                    } else return "move " + choice.id + " mega";
                } else if (battleside.active[0].item.indexOf('iumz')>-1) {
                    //@@ blablabla-IUMZ, such as tapunIUMZ
                    if (battleside.active[0].item.slice(0,3).toLowerCase() == Moves[choice.id].type.slice(0,3).toLowerCase()){
                        if (!battleside.zmoved){
                            battleside.zmoved = 0;
                        }
                        if (battleside.zmoved==0){
                            battleside.zmoved = 1;
                            return "move " + choice.id + " zmove";
                        } else return "move " + choice.id;

                } else if (battleside.active[0].name.toLowerCase().indexOf(battleside.active[0].item.toLowerCase().slice(0,battleside.active[0].item.length-4)>-1)){
                    //@@ GYARADOSite ~ GYARADOS ?

                    //Does Z item match with the move's type?
                    if (Items[battleside.active[0].item].zMoveType == Moves[choice.id].type){
                        if (!battleside.active[0].zmoved){
                            battleside.active[0].zmoved = 0;
                        }
                        if (battleside.active[0].zmoved==0){
                            battleside.active[0].zmoved = 1;
                            return "move " + choice.id + " zmove";
                        } else return "move " + choice.id;
                    } else return "move " + choice.id;
                } else {
                    console.log('OTHER CASES', battleside.active[0].item, battleside.active[0].name)
                    return "move " + choice.id;
                }
            } else return "move " + choice.id;
                
            } else if (choice.type == "switch") {
                return "switch " + (choice.id + 1);
            }
        },
        parseRequest: function(request) {
            var choices = [];

            if(!request) return choices; // Empty request
            if(request.wait) return choices; // This player is not supposed to make a move

            // If we can make a move
            if (request.active) {
                _.each(request.active[0].moves, function(move) {
                    if (!move.disabled) {
                        choices.push({
                            "type": "move",
                            "id": move.id
                        });
                    }
                });
            }

            // Switching options
            var trapped = (request.active) ? (request.active[0].trapped || request.active[0].maybeTrapped) : false;
            var canSwitch = request.forceSwitch || !trapped;
            if (canSwitch) {
                _.each(request.side.pokemon, function(pokemon, index) {
                    if (pokemon.condition.indexOf("fnt") < 0 && !pokemon.active) {
                        choices.push({
                            "type": "switch",
                            "id": index
                        });
                    }
                });
            }

            return {
                rqid: request.rqid,
                choices: choices
            };
        }
    }
});
module.exports = BattleRoom;

var minimaxbot = require("./bots/minimaxbot");
var greedybot = require("./bots/greedybot");
var randombot = require("./bots/randombot");
