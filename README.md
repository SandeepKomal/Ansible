###  Anisble Installation steps:
```
sudo yum install python3-pip -y
```
```
python3 --version 
```
```
pip --version 
```
```
pip install ansible 
```

### To create a Folder on the Tareget Server 

```
ansible -i inventory all -m "shell" -a "touch devops"  
```
### The command to Run a Ansible playbook 

```
ansible-playbook -i inventory.ini playbook.yaml
```
