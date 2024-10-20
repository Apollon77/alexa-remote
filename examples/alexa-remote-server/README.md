# Alexa remote server

This example shows how you to keep a session and persist it for the next time you run the server.  
To run the server, execute from this folder:
```
npm install
npm start
```
And access [http://localhost:3000/reconnect](http://localhost:3000/reconnect).  
You will be redirected to the login page, and after that, your session will be saved to `HomeFolder/.alexaRemote`.  
You can then do a post to send the `speak` command to an alexa by its name (Kitchen in this example):  
`curl 'http://localhost:3000/speak' -H 'Content-Type: application/json' --data-raw '{"deviceName":"Kitchen","text":"Hi"}'`  

