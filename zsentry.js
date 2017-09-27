/**
 * Logic that negotiates the boundary between normal terminal
 * traffic and ZMODEM: we look for the tell-tale signs of a ZMODEM
 * transfer and allow the client to determine whether it’s really
 * ZMODEM or not.
 *
 * This logic is not unlikely to need tweaking, and it can never
 * be fully bulletproof; if it could be bulletproof it would be
 * simpler since there wouldn’t need to be the .confirm()/.deny()
 * step.
 *
 * One thing you could do to make things a bit simpler *is* just
 * to make that assumption for your users--i.e., to .confirm()
 * Detection objects automatically. That’ll be one less step
 * for the user, but an unaccustomed user might find that a bit
 * confusing.
 *
 * Workflow:
 *  - parse all input with .consume(). As long as nothing looks
 *      like ZMODEM, all the traffic will go to to_terminal().
 *
 *  - when a “tell-tale” sequence of bytes arrives, we create a
 *      Detection object and pass it to the “on_detect” handler.
 *
 *  - Either .confirm() or .deny() with the Detection object.
 *      This is the user’s chance to say, “yeah, I know those
 *      bytes look like ZMODEM, but they’re not. So back off!”
 *
 *      If you .confirm(), the Session object is returned, and
 *      further input that goes to the Sentry’s .consume() will
 *      go to the (now-active) Session object.
 *
 *  - Sometimes additional traffic arrives that makes it apparent
 *      that no ZMODEM session is intended to start; in this case,
 *      the Sentry marks the Detection as “stale” and calls the
 *      “on_retract” handler. Any attempt from here to .confirm()
 *      on the Detection object will prompt an exception.
 *
 *      (This “retraction” behavior will only happen prior to
 *      .confirm() or .deny() being called on the Detection object.
 *      Beyond that point, either the Session has to deal with the
 *      “garbage”, or it’s back to the terminal anyway.
 *
 *  - Once the Session object is done, the Sentry will again send
 *      all traffic to to_terminal().
 */

( function() {
    "use strict";

    const
        MIN_ZM_HEX_START_LENGTH = 20,
        MAX_ZM_HEX_START_LENGTH = 21,

        // **, ZDLE, 'B0'
        //ZRQINIT’s next byte will be '0'; ZRINIT’s will be '1'.
        COMMON_ZM_HEX_START = [ 42, 42, 24, 66, 48 ],

        SENTRY_CONSTRUCTOR_REQUIRED_ARGS = [
            "to_terminal",
            "on_detect",
            "on_retract",
            "sender",
        ],

        ASTERISK = 42
    ;

    /**
     * An instance of this object is passed to the Sentry’s on_detect
     * callback each time the Sentry object sees what looks like the
     * start of a ZMODEM session.
     */
    class Detection {
        constructor(session_type, accepter, denier, checker) {

            //confirm() - user confirms that ZMODEM is desired
            this.confirm = accepter;

            //deny() - user declines ZMODEM; send abort sequence
            //
            //TODO: It might be ideal to forgo the session “peaceably”,
            //i.e., such that the peer doesn’t end in error. That’s
            //possible if we’re the sender, we accept the session,
            //then we just send a close(), but it doesn’t seem to be
            //possible for a receiver. Thus, let’s just leave it so
            //it’s at least consistent (and simpler, too).
            this.deny = denier;

            this.is_valid = checker;

            this._session_type = session_type;
        }

        get_session_type() { return this._session_type }
    }

    /**
     * Class that parses an input stream for the beginning of a
     * ZMODEM session.
     */
    Zmodem.Sentry = class ZmodemSentry {
        constructor(options) {
            if (!options) throw "Need options!";

            var sentry = this;
            SENTRY_CONSTRUCTOR_REQUIRED_ARGS.forEach( function(arg) {
                if (!options[arg]) {
                    throw "Need “" + arg + "”!";
                }
                sentry["_" + arg] = options[arg];
            } );

            this._cache = [];
        }

        _after_session_end() {
            this._zsession = null;
        }

        /**
         * “Consumes” a piece of input:
         *
         *  - If there is no active or pending ZMODEM session, the text is
         *      all output. (This is regardless of whether we’ve got a new
         *      Session.)
         *
         *  - If there is no active ZMODEM session and the input *ends* with
         *      a ZRINIT or ZRQINIT, then a new Session object is created,
         *      and its accepter is passed to the “on_detect” function.
         *      If there was another pending Session object, it is expired.
         *
         *  - If there is no active ZMODEM session and the input does NOT end
         *      with a ZRINIT or ZRQINIT, then any pending Session object is
         *      expired, and “on_retract” is called.
         *
         *  - If there is an active ZMODEM session, the input is passed to it.
         *      Any non-ZMODEM data parsed from the input is sent to output.
         *      If the ZMODEM session ends, any post-ZMODEM part of the input
         *      is sent to output.
         */

        consume(input) {
            if (!(input instanceof Array)) {
                input = Array.prototype.slice.call( new Uint8Array(input) );
            }

            if (this._zsession) {
                var session_before_consume = this._zsession;

                session_before_consume.consume(input);

                if (session_before_consume.has_ended()) {
                    if (session_before_consume.type === "receive") {
                        input = session_before_consume.get_trailing_bytes();
                    }
                    else {
                        input = [];
                    }
                }
                else return;
            }

            var new_session = this._parse(input);
            var to_terminal = input;

            if (new_session) {
                let replacement_detect = !!this._parsed_session;

                if (replacement_detect) {
                    //no terminal output if the new session is of the
                    //same type as the old
                    if (this._parsed_session.type === new_session.type) {
                        to_terminal = [];
                    }

                    this._on_retract();
                }

                this._parsed_session = new_session;

                var sentry = this;

                function checker() {
                    return sentry._parsed_session === new_session;
                }

                //This runs with the Sentry object as the context.
                function accepter() {
                    if (!this.is_valid()) {
                        throw "Stale ZMODEM session!";
                    }

                    new_session.on("garbage", sentry._to_terminal);

                    new_session.on(
                        "session_end",
                        sentry._after_session_end.bind(sentry)
                    );

                    new_session.set_sender(sentry._sender);

                    delete sentry._parsed_session;

                    return sentry._zsession = new_session;
                };

                this._on_detect( new Detection(
                    new_session.type,
                    accepter,
                    this._send_abort.bind(this),
                    checker
                ) );
            }
            else {
                /*
                if (this._parsed_session) {
                    this._session_stale_because = 'Non-ZMODEM output received after ZMODEM initialization.';
                }
                */

                var expired_session = this._parsed_session;

                this._parsed_session = null;

                if (expired_session) {

                    //If we got a single “C” after parsing a session,
                    //that means our peer is trying to downgrade to YMODEM.
                    //That won’t work, so we just send the ABORT_SEQUENCE
                    //right away.
                    if (to_terminal.length === 1 && to_terminal[0] === 67) {
                        this._send_abort();
                    }

                    this._on_retract();
                }
            }

            this._to_terminal(to_terminal);
        }

        _send_abort() {
            this._sender( Zmodem.ZMLIB.ABORT_SEQUENCE );
        }

        /**
         * Parse an input stream and decide how much of it goes to the
         * terminal or to a new Session object.
         *
         * This will accommodate input strings that are fragmented
         * across calls to this function; e.g., if you send the first
         * two bytes at the end of one parse() call then send the rest
         * at the beginning of the next, parse() will recognize it as
         * the beginning of a ZMODEM session.
         *
         * In order to keep from blocking any actual useful data to the
         * terminal in real-time, this will send on the initial
         * ZRINIT/ZRQINIT bytes to the terminal. They’re meant to go to the
         * terminal anyway, so that should be fine.
         *
         * @param {Array|Uint8Array} array_like - The input bytes.
         *      Each member should be a number between 0 and 255 (inclusive).
         *
         * @return {Array} A two-member list:
         *      0) the bytes that should be printed on the terminal
         *      1) the created Session object (if any)
         */
        _parse(array_like) {
            var cache = this._cache;

            cache.push.apply( cache, array_like );

            while (true) {
                let common_hex_at = Zmodem.ZMLIB.find_subarray( cache, COMMON_ZM_HEX_START );
                if (-1 === common_hex_at) break;

                let before_common_hex = cache.splice(0, common_hex_at);
                let zsession;
                try {
                    zsession = Zmodem.Session.parse(cache);
                } catch(err) {     //ignore errors
                    //console.log(err);
                }

                if (!zsession) break;

                //Don’t need to parse the trailing XON.
                if ((cache.length === 1) && (cache[0] === Zmodem.ZMLIB.XON)) {
                    cache.shift();
                }

                //If there are still bytes in the cache,
                //then we don’t have a ZMODEM session. This logic depends
                //on the sender only sending one initial header.
                return cache.length ? null : zsession;
            }

            cache.splice( MAX_ZM_HEX_START_LENGTH );

            return null;
        }
    }
}());
